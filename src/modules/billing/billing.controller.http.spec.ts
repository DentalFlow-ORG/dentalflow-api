import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';

import { AccessPolicyService } from '../../common/services/access-policy.service';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { WebhookService } from './webhook.service';

/**
 * Observes the real HTTP status of the billing routes, which the service-level
 * specs cannot see. Guards are registered globally through APP_GUARD, so a bare
 * testing module exercises the controller without authentication.
 */
describe('BillingController — HTTP contract', () => {
  const CLINIC = 'clinic-1';
  const SESSION_ID = 'cs_test_a1b2c3d4e5';

  const subscriptionStatus = {
    hasSubscription: true,
    status: 'active',
    planKey: 'professional',
    planName: 'Professional',
    billingInterval: 'monthly',
    stripeCustomerId: 'cus_1',
    stripeSubscriptionId: 'sub_1',
    trialEndsAt: null,
    currentPeriodEnd: '2026-10-15T18:45:51.000Z',
    cancelAtPeriodEnd: true,
    accessAllowed: true,
    requiresPlanSelection: false,
    requiresPayment: false,
    message: 'Assinatura com acesso liberado.',
  };

  let app: INestApplication<App>;
  const syncCheckoutSession = jest.fn().mockResolvedValue(undefined);
  const getCurrentSubscriptionStatus = jest
    .fn()
    .mockResolvedValue(subscriptionStatus);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [BillingController],
      providers: [
        { provide: BillingService, useValue: { getCurrentSubscriptionStatus } },
        { provide: WebhookService, useValue: { syncCheckoutSession } },
        {
          provide: AccessPolicyService,
          useValue: { assertOwnerAccess: () => CLINIC },
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    syncCheckoutSession.mockClear();
    getCurrentSubscriptionStatus.mockClear();
  });

  describe('POST /billing/checkout-session/sync', () => {
    it('answers 200, not Nest\u2019s default 201 for a POST', async () => {
      // Reconciling an existing Stripe session creates no DentalFlow resource,
      // and AGENTS.md documents this route as returning 200.
      await request(app.getHttpServer())
        .post('/billing/checkout-session/sync')
        .send({ sessionId: SESSION_ID })
        .expect(200);
    });

    it('returns the clinic subscription status unchanged', async () => {
      const response = await request(app.getHttpServer())
        .post('/billing/checkout-session/sync')
        .send({ sessionId: SESSION_ID })
        .expect(200);

      expect(response.body).toEqual(subscriptionStatus);
      expect(syncCheckoutSession).toHaveBeenCalledWith(SESSION_ID, CLINIC);
    });

    it('stays idempotent across repeated calls', async () => {
      const first = await request(app.getHttpServer())
        .post('/billing/checkout-session/sync')
        .send({ sessionId: SESSION_ID })
        .expect(200);
      const second = await request(app.getHttpServer())
        .post('/billing/checkout-session/sync')
        .send({ sessionId: SESSION_ID })
        .expect(200);

      expect(second.status).toBe(first.status);
      expect(second.body).toEqual(first.body);
      expect(syncCheckoutSession).toHaveBeenCalledTimes(2);
    });

    it('still rejects a malformed session id', async () => {
      await request(app.getHttpServer())
        .post('/billing/checkout-session/sync')
        .send({ sessionId: 'not-a-session' })
        .expect(400);

      expect(syncCheckoutSession).not.toHaveBeenCalled();
    });
  });
});
