import { BadRequestException } from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';

import { WebhookService } from './webhook.service';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const stripeClientMock = {
  webhooks: { constructEvent: jest.fn() },
  subscriptions: { retrieve: jest.fn(), cancel: jest.fn() },
  checkout: { sessions: { retrieve: jest.fn() } },
};

const stripeMock = {
  getClient: jest.fn(),
  getWebhookSecret: jest.fn(),
};

const prismaMock = {
  stripeEvent: { upsert: jest.fn(), update: jest.fn() },
  subscription: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn(),
  },
  subscriptionItem: { upsert: jest.fn(), deleteMany: jest.fn() },
  $transaction: jest.fn(),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildService(): WebhookService {
  return new WebhookService(prismaMock as never, stripeMock as never);
}

const RAW_BODY = Buffer.from('{}');
const SIGNATURE = 'test-sig';

function makeStripeEvent(type: string, dataObject: Record<string, unknown> = {}) {
  return {
    id: 'evt_test',
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object: dataObject },
  };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('WebhookService', () => {
  let service: WebhookService;

  beforeEach(() => {
    jest.clearAllMocks();
    stripeMock.getClient.mockReturnValue(stripeClientMock);
    stripeMock.getWebhookSecret.mockReturnValue('whsec_test');
    prismaMock.$transaction.mockResolvedValue([]);
    prismaMock.subscriptionItem.deleteMany.mockResolvedValue({});
    service = buildService();
  });

  describe('signature verification', () => {
    it('throws BadRequestException when Stripe signature is invalid', async () => {
      stripeClientMock.webhooks.constructEvent.mockImplementation(() => {
        throw new Error('No signatures found matching expected signature');
      });

      await expect(service.handleWebhook(RAW_BODY, SIGNATURE)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('idempotency', () => {
    it('returns early and skips dispatch when event is already processed', async () => {
      stripeClientMock.webhooks.constructEvent.mockReturnValue(
        makeStripeEvent('customer.subscription.updated'),
      );
      prismaMock.stripeEvent.upsert.mockResolvedValue({ processed: true });

      await service.handleWebhook(RAW_BODY, SIGNATURE);

      expect(prismaMock.stripeEvent.update).not.toHaveBeenCalled();
      expect(prismaMock.subscription.findFirst).not.toHaveBeenCalled();
    });

    it('upserts the StripeEvent record using the Stripe event ID as PK', async () => {
      stripeClientMock.webhooks.constructEvent.mockReturnValue(
        makeStripeEvent('unhandled.event.type'),
      );
      prismaMock.stripeEvent.upsert.mockResolvedValue({ processed: false });
      prismaMock.stripeEvent.update.mockResolvedValue({});

      await service.handleWebhook(RAW_BODY, SIGNATURE);

      expect(prismaMock.stripeEvent.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'evt_test' } }),
      );
    });
  });

  describe('dispatch lifecycle', () => {
    it('marks event as processed after a successful unknown event type', async () => {
      stripeClientMock.webhooks.constructEvent.mockReturnValue(
        makeStripeEvent('unhandled.event.type'),
      );
      prismaMock.stripeEvent.upsert.mockResolvedValue({ processed: false });
      prismaMock.stripeEvent.update.mockResolvedValue({});

      await service.handleWebhook(RAW_BODY, SIGNATURE);

      expect(prismaMock.stripeEvent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ processed: true, errorMessage: null }),
        }),
      );
    });

    it('stores errorMessage without re-throwing when dispatch fails', async () => {
      stripeClientMock.webhooks.constructEvent.mockReturnValue(
        makeStripeEvent('customer.subscription.updated', {
          id: 'sub_test',
          customer: 'cus_test',
          status: 'active',
          items: { data: [] },
          cancel_at_period_end: false,
          canceled_at: null,
          trial_end: null,
        }),
      );
      prismaMock.stripeEvent.upsert.mockResolvedValue({ processed: false });
      prismaMock.subscription.findFirst.mockRejectedValue(new Error('DB connection lost'));
      prismaMock.stripeEvent.update.mockResolvedValue({});

      await expect(service.handleWebhook(RAW_BODY, SIGNATURE)).resolves.toBeUndefined();

      expect(prismaMock.stripeEvent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ errorMessage: 'DB connection lost' }),
        }),
      );
    });

    it('does not mark event as processed when dispatch fails', async () => {
      stripeClientMock.webhooks.constructEvent.mockReturnValue(
        makeStripeEvent('customer.subscription.updated', {
          id: 'sub_test',
          customer: 'cus_test',
          status: 'active',
          items: { data: [] },
          cancel_at_period_end: false,
          canceled_at: null,
          trial_end: null,
        }),
      );
      prismaMock.stripeEvent.upsert.mockResolvedValue({ processed: false });
      prismaMock.subscription.findFirst.mockRejectedValue(new Error('timeout'));
      prismaMock.stripeEvent.update.mockResolvedValue({});

      await service.handleWebhook(RAW_BODY, SIGNATURE);

      const updateCall = prismaMock.stripeEvent.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(updateCall.data).not.toHaveProperty('processed', true);
    });
  });

  describe('customer.subscription.deleted', () => {
    it('marks local subscription as CANCELED', async () => {
      stripeClientMock.webhooks.constructEvent.mockReturnValue(
        makeStripeEvent('customer.subscription.deleted', {
          id: 'sub_test',
          customer: 'cus_test',
          status: 'canceled',
          items: { data: [] },
          cancel_at_period_end: false,
          canceled_at: null,
          ended_at: null,
          trial_end: null,
        }),
      );
      prismaMock.stripeEvent.upsert.mockResolvedValue({ processed: false });
      prismaMock.stripeEvent.update.mockResolvedValue({});
      prismaMock.subscription.findFirst.mockResolvedValue({
        id: 'local-sub-1',
        clinicId: 'clinic-1',
        stripeSubscriptionId: 'sub_test',
        stripeCustomerId: 'cus_test',
      });
      prismaMock.subscription.update.mockResolvedValue({});

      await service.handleWebhook(RAW_BODY, SIGNATURE);

      expect(prismaMock.subscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: SubscriptionStatus.CANCELED }),
        }),
      );
    });

    it('returns early without updating when no local subscription is found', async () => {
      stripeClientMock.webhooks.constructEvent.mockReturnValue(
        makeStripeEvent('customer.subscription.deleted', {
          id: 'sub_orphan',
          customer: 'cus_orphan',
          status: 'canceled',
          items: { data: [] },
          cancel_at_period_end: false,
          canceled_at: null,
          ended_at: null,
          trial_end: null,
        }),
      );
      prismaMock.stripeEvent.upsert.mockResolvedValue({ processed: false });
      prismaMock.stripeEvent.update.mockResolvedValue({});
      prismaMock.subscription.findFirst.mockResolvedValue(null);

      await service.handleWebhook(RAW_BODY, SIGNATURE);

      expect(prismaMock.subscription.update).not.toHaveBeenCalled();
    });
  });

  describe('invoice.payment_failed', () => {
    it('marks local subscription as PAST_DUE', async () => {
      stripeClientMock.webhooks.constructEvent.mockReturnValue(
        makeStripeEvent('invoice.payment_failed', {
          customer: 'cus_test',
          parent: { subscription_details: { subscription: 'sub_test' } },
        }),
      );
      prismaMock.stripeEvent.upsert.mockResolvedValue({ processed: false });
      prismaMock.stripeEvent.update.mockResolvedValue({});
      prismaMock.subscription.findFirst.mockResolvedValue({
        id: 'local-sub-1',
        clinicId: 'clinic-1',
        stripeSubscriptionId: 'sub_test',
        stripeCustomerId: 'cus_test',
      });
      prismaMock.subscription.update.mockResolvedValue({});

      await service.handleWebhook(RAW_BODY, SIGNATURE);

      expect(prismaMock.subscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: SubscriptionStatus.PAST_DUE }),
        }),
      );
    });
  });
});
