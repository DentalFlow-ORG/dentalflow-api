import {
  ServiceUnavailableException,
  UnprocessableEntityException,
  UnauthorizedException,
} from '@nestjs/common';
import { AiAssistantAnalysisType } from '@prisma/client';
import { AuthService } from '../modules/auth/auth.service';
import { HealthController } from '../modules/health/health.controller';
import { HealthService } from '../modules/health/health.service';
import { AiQuotaService } from '../modules/ai-assistant/ai-quota.service';
import { WebhookService } from '../modules/billing/webhook.service';
import { WhatsAppWebhookService } from '../modules/notification/whatsapp-webhook.service';

describe('Production hardening regressions', () => {
  it('reports database unavailability as 503', async () => {
    const service = new HealthService({
      $queryRaw: jest.fn().mockRejectedValue(new Error('offline')),
    } as never);
    await expect(
      new HealthController(service).getStatus(),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it.each(['starter', 'professional'])(
    'does not advertise dictation quota for %s',
    async (slug) => {
      const service = new AiQuotaService({
        subscription: {
          findFirst: jest.fn().mockResolvedValue({ plan: { slug } }),
        },
        aiAssistantAnalysis: {
          count: jest.fn().mockResolvedValue(0),
          findFirst: jest.fn().mockResolvedValue(null),
        },
      } as never);
      await expect(
        service.getQuota('clinic', AiAssistantAnalysisType.CLINICAL_DICTATION),
      ).resolves.toMatchObject({ allowed: false, limit: 0, remaining: 0 });
    },
  );

  it('rejects a reset token claimed concurrently without changing the password', async () => {
    const tx = {
      passwordResetToken: {
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      user: { update: jest.fn() },
      refreshToken: { updateMany: jest.fn() },
    };
    const prisma = {
      passwordResetToken: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'reset',
          userId: 'user',
          usedAt: null,
          expiresAt: new Date(Date.now() + 60000),
          user: { isActive: true, deletedAt: null },
        }),
      },
      $transaction: jest.fn((work: (client: typeof tx) => Promise<unknown>) =>
        work(tx),
      ),
    };
    const service = new AuthService(
      prisma as never,
      {} as never,
      {} as never,
      { log: jest.fn() } as never,
      {} as never,
      {} as never,
    );
    await expect(
      service.resetPassword({
        token: 'test',
        newPassword: 'A-new-password-123!',
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('rejects unsigned production Meta callbacks even when sending is disabled', () => {
    const saved = { ...process.env };
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.WHATSAPP_APP_SECRET;
      delete process.env.WHATSAPP_WEBHOOK_APP_SECRET;
      const service = new WhatsAppWebhookService({} as never);
      expect(() => service.receive({})).toThrow(UnauthorizedException);
    } finally {
      process.env = saved;
    }
  });

  it('does not acknowledge a failed Meta database write', async () => {
    const saved = { ...process.env };
    try {
      process.env.NODE_ENV = 'test';
      delete process.env.WHATSAPP_APP_SECRET;
      delete process.env.WHATSAPP_WEBHOOK_APP_SECRET;
      const service = new WhatsAppWebhookService({
        notificationMessage: {
          updateMany: jest.fn().mockRejectedValue(new Error('offline')),
        },
      } as never);
      await expect(
        Promise.resolve(
          service.receive({
            entry: [
              {
                changes: [
                  {
                    value: { statuses: [{ id: 'wamid.test', status: 'sent' }] },
                  },
                ],
              },
            ],
          }),
        ),
      ).rejects.toThrow();
    } finally {
      process.env = saved;
    }
  });

  it('returns a retryable failure when Stripe processing fails', async () => {
    const prisma = {
      stripeEvent: {
        upsert: jest.fn().mockResolvedValue({ processed: false }),
        update: jest.fn(),
      },
      subscription: {
        findFirst: jest.fn().mockRejectedValue(new Error('offline')),
      },
    };
    const stripe = {
      getClient: () => ({
        webhooks: {
          constructEvent: () => ({
            id: 'evt_test',
            type: 'customer.subscription.deleted',
            created: 1,
            data: { object: { id: 'sub_old', customer: 'cus_1' } },
          }),
        },
      }),
      getWebhookSecret: () => 'test',
    };
    Object.assign(prisma, {
      $executeRaw: jest.fn(),
      $transaction: (work: (tx: typeof prisma) => Promise<unknown>) =>
        work(prisma),
    });
    Object.assign(prisma.stripeEvent, {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ processed: false }),
    });
    const service = new WebhookService(prisma as never, stripe as never);
    await expect(
      service.handleWebhook(Buffer.from('{}'), 'signature'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.stripeEvent.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ processed: true }),
      }),
    );
  });

  it('does not cancel the current subscription for an old subscription event from the same customer', async () => {
    const current = {
      id: 'local',
      clinicId: 'clinic',
      stripeSubscriptionId: 'sub_current',
      stripeCustomerId: 'cus_1',
    };
    const prisma = {
      stripeEvent: {
        upsert: jest.fn().mockResolvedValue({ processed: false }),
        update: jest.fn(),
      },
      subscription: {
        findFirst: jest.fn(({ where }) =>
          Promise.resolve(where.OR ? current : null),
        ),
        update: jest.fn(),
      },
      subscriptionItem: { deleteMany: jest.fn() },
      $transaction: jest.fn(),
    };
    const stripe = {
      getClient: () => ({
        webhooks: {
          constructEvent: () => ({
            id: 'evt_old',
            type: 'customer.subscription.deleted',
            created: 1,
            data: {
              object: { id: 'sub_old', customer: 'cus_1', items: { data: [] } },
            },
          }),
        },
      }),
      getWebhookSecret: () => 'test',
    };
    Object.assign(prisma, {
      $executeRaw: jest.fn(),
      $transaction: (work: (tx: typeof prisma) => Promise<unknown>) =>
        work(prisma),
    });
    Object.assign(prisma.stripeEvent, {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ processed: false }),
    });
    await new WebhookService(prisma as never, stripe as never).handleWebhook(
      Buffer.from('{}'),
      'signature',
    );
    expect(prisma.subscription.update).not.toHaveBeenCalled();
  });
});
