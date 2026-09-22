import { createHash } from 'node:crypto';
import { AuthService } from '../../src/modules/auth/auth.service';
import { WebhookService } from '../../src/modules/billing/webhook.service';
import {
  createIntegrationHarness,
  IntegrationHarness,
} from '../support/integration-harness';
import { PatientIdentityService } from '../../src/common/services/patient-identity.service';
import { PatientsService } from '../../src/modules/patients/patients.service';
import { createAppointment, seedTwoClinics } from '../support/factories';

describe('Production hardening (PostgreSQL)', () => {
  let h: IntegrationHarness;
  beforeAll(async () => {
    h = await createIntegrationHarness();
  }, 60000);
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.truncate();
  });

  it('allows exactly one concurrent password reset and revokes prior sessions', async () => {
    const { ownerA } = await seedTwoClinics(h.prisma);
    const token = 'local-test-reset-token';
    await h.prisma.passwordResetToken.create({
      data: {
        userId: ownerA.id,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    const auth = h.app.get(AuthService);
    const results = await Promise.allSettled([
      auth.resetPassword({ token, newPassword: 'First-new-password-123!' }),
      auth.resetPassword({ token, newPassword: 'Second-new-password-456!' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const user = await h.prisma.user.findUniqueOrThrow({
      where: { id: ownerA.id },
    });
    expect(user.tokenVersion).toBe((ownerA.tokenVersion ?? 0) + 1);
    const response = await h
      .get('/auth/me')
      .set('Authorization', 'Bearer ' + h.tokenFor(ownerA));
    expect(response.status).toBe(401);
  });

  it('replays a failed Stripe event and deduplicates a completed event', async () => {
    const event = {
      id: 'evt_local_retry',
      type: 'customer.subscription.updated',
      created: 1,
      data: {
        object: { id: 'sub_old', customer: 'cus_test', items: { data: [] } },
      },
    };
    const retrieve = jest
      .fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue(event.data.object);
    const stripe = {
      getClient: () => ({
        webhooks: { constructEvent: () => event },
        subscriptions: { retrieve },
      }),
      getWebhookSecret: () => 'test',
    };
    const service = new WebhookService(h.prisma as never, stripe as never);
    await expect(
      service.handleWebhook(Buffer.from('{}'), 'test'),
    ).rejects.toThrow();
    expect(
      await h.prisma.stripeEvent.findUnique({ where: { id: event.id } }),
    ).toMatchObject({ processed: false });
    await service.handleWebhook(Buffer.from('{}'), 'test');
    const stored = await h.prisma.stripeEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(stored.processed).toBe(true);
    expect(stored.errorMessage).toBeNull();
    await service.handleWebhook(Buffer.from('{}'), 'test');
    expect(await h.prisma.stripeEvent.count()).toBe(1);
    expect(
      (
        await h.prisma.stripeEvent.findUniqueOrThrow({
          where: { id: event.id },
        })
      ).processedAt,
    ).toEqual(stored.processedAt);
  });
});

describe('Stripe concurrent delivery and authoritative state (PostgreSQL)', () => {
  let h: IntegrationHarness;
  beforeAll(async () => {
    h = await createIntegrationHarness();
  }, 60000);
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.truncate();
  });
  it('serializes duplicate delivery, ignores stale status and updates plan from the current Stripe price', async () => {
    await seedTwoClinics(h.prisma);
    await h.prisma.subscription.update({
      where: { clinicId: 'clinic-a' },
      data: { stripeSubscriptionId: 'sub_current', stripeCustomerId: 'cus_a' },
    });
    const newPlan = await h.prisma.plan.create({
      data: {
        name: 'Professional',
        slug: 'professional',
        priceMonthly: 100,
        priceYearly: 1000,
        maxUsersPerClinic: 16,
        stripePriceIdMonthly: 'price_new',
      },
    });
    const current = {
      id: 'sub_current',
      customer: 'cus_a',
      status: 'active',
      items: {
        data: [
          {
            id: 'si_current',
            quantity: 1,
            current_period_start: 1780000000,
            current_period_end: 1782000000,
            price: {
              id: 'price_new',
              recurring: { interval: 'month' },
              currency: 'brl',
              unit_amount: 100,
              unit_amount_decimal: '100',
              nickname: null,
            },
          },
        ],
      },
    };
    const event = {
      id: 'evt_concurrent',
      type: 'customer.subscription.updated',
      created: 1,
      data: { object: { ...current, status: 'past_due' } },
    };
    const retrieve = jest.fn().mockResolvedValue(current);
    const stripe = {
      getClient: () => ({
        webhooks: { constructEvent: () => event },
        subscriptions: { retrieve },
      }),
      getWebhookSecret: () => 'test',
    };
    const service = new WebhookService(h.prisma as never, stripe as never);
    await Promise.all([
      service.handleWebhook(Buffer.from('{}'), 'test'),
      service.handleWebhook(Buffer.from('{}'), 'test'),
    ]);
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(
      await h.prisma.subscription.findUnique({
        where: { clinicId: 'clinic-a' },
      }),
    ).toMatchObject({ status: 'ACTIVE', planId: newPlan.id });
    expect(await h.prisma.subscriptionItem.count()).toBe(1);
    expect(
      await h.prisma.stripeEvent.count({ where: { processed: true } }),
    ).toBe(1);
  });
});

describe('Patient identity containment (PostgreSQL)', () => {
  let h: IntegrationHarness;
  beforeAll(async () => {
    h = await createIntegrationHarness();
  }, 60000);
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.truncate();
    await seedTwoClinics(h.prisma);
  });
  it('blocks a name-only collision within its clinic without leaking the other clinic', async () => {
    await createAppointment(h.prisma, { id: 'identity-a', patientEmail: null });
    await createAppointment(h.prisma, { id: 'identity-b', patientEmail: null });
    await h.prisma.appointment.update({
      where: { id: 'identity-a' },
      data: { patientPhone: '(11) 99999-0000' },
    });
    await h.prisma.appointment.update({
      where: { id: 'identity-b' },
      data: { patientPhone: '11988880000' },
    });
    const service = h.app.get(PatientIdentityService);
    await expect(
      service.assertUnambiguousIdentity('clinic-a', 'maria silva'),
    ).rejects.toThrow();
    await expect(
      service.assertUnambiguousIdentity('clinic-b', 'maria silva'),
    ).resolves.toBeUndefined();
  });
  it('does not multiply appointment counts when legacy avatar identifiers differ only by case', async () => {
    await createAppointment(h.prisma, { id: 'identity-a' });
    await h.prisma.patientAvatar.createMany({
      data: [
        {
          clinicId: 'clinic-a',
          identifier: 'maria@example.test',
          avatarUrl: 'a',
        },
        {
          clinicId: 'clinic-a',
          identifier: 'MARIA@example.test',
          avatarUrl: 'b',
        },
      ],
    });
    const result = await h.app.get(PatientsService).listPatients('clinic-a');
    expect(result.data).toHaveLength(1);
    expect(result.data[0].totalAppointments).toBe(1);
  });
});
