import { NotificationService } from '../../src/modules/notification/notification.service';
import {
  INotificationProvider,
  NOTIFICATION_PROVIDER,
} from '../../src/modules/notification/providers/notification-provider.interface';
import {
  createIntegrationHarness,
  IntegrationHarness,
} from '../support/integration-harness';
import {
  createClinic,
  createPlan,
  createUser,
  subscribeClinic,
} from '../support/factories';

/**
 * NOTIFICATION QUOTA CONCURRENCY
 *
 * The monthly WhatsApp allowance is what stands between a clinic's plan and an
 * unbounded Meta bill.
 *
 * `send()` originally read the counter, decided, sent, and incremented
 * afterwards. Against this suite that proved to offer no protection at all:
 * with an allowance of three and ten concurrent sends, all ten were delivered,
 * because every one of them read the same pre-send value. It is now an atomic
 * conditional claim made before the send, released if the provider fails.
 *
 * The interleaving here is genuine rather than simulated — real connections
 * against real PostgreSQL — which is the only way this class of defect shows
 * itself.
 *
 * The assertion is on the invariant, not on the implementation: whatever the
 * mechanism, the number of messages recorded as SENT must never exceed the
 * plan's allowance.
 */

const CLINIC = 'clinic-quota';
const ACTOR = 'owner-quota';
const PHONE = '11999998888';
const TEMPLATE = 'appointment_reminder';

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

describe('Notification quota under concurrency (real database)', () => {
  let h: IntegrationHarness;
  let service: NotificationService;

  beforeAll(async () => {
    h = await createIntegrationHarness();
    service = h.app.get(NotificationService);
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  /** A clinic whose plan allows exactly `limit` WhatsApp messages a month. */
  async function seedClinicWithAllowance(limit: number) {
    await h.truncate();
    await createClinic(h.prisma, { id: CLINIC, name: 'Clínica Quota' });
    await createPlan(h.prisma, { id: 'plan-quota', slug: 'quota-plan' });
    await h.prisma.plan.update({
      where: { id: 'plan-quota' },
      data: { hasWhatsApp: true, whatsappMonthlyLimit: limit },
    });
    await subscribeClinic(h.prisma, CLINIC, { planId: 'plan-quota' });
    await createUser(h.prisma, { id: ACTOR, clinicId: CLINIC, role: 'OWNER' });

    await h.prisma.notificationTemplate.create({
      data: {
        slug: TEMPLATE,
        channel: 'WHATSAPP',
        category: 'UTILITY',
        bodyPt: 'Olá {{1}}, sua consulta é em {{2}} às {{3}}.',
        variables: ['nome', 'data', 'hora'],
        isActive: true,
      },
    });

    await h.prisma.notificationConsent.create({
      data: {
        clinicId: CLINIC,
        phone: PHONE,
        channel: 'WHATSAPP',
        scope: 'UTILITY',
        granted: true,
        source: 'FORM',
      },
    });
  }

  const send = () =>
    service.send(CLINIC, ACTOR, {
      templateSlug: TEMPLATE,
      phone: PHONE,
    } as never);

  async function sentCount(): Promise<number> {
    return h.prisma.notificationMessage.count({
      where: { clinicId: CLINIC, status: 'SENT' },
    });
  }

  async function usedQuota(): Promise<number> {
    const row = await h.prisma.notificationQuota.findUnique({
      where: {
        clinicId_month_channel: {
          clinicId: CLINIC,
          month: currentMonth(),
          channel: 'WHATSAPP',
        },
      },
    });
    return row?.used ?? 0;
  }

  // ── Sequential behaviour: the baseline that must keep working ──────────────

  describe('sequentially', () => {
    it('allows exactly the allowance and refuses the next', async () => {
      await seedClinicWithAllowance(2);

      await expect(send()).resolves.toBeDefined();
      await expect(send()).resolves.toBeDefined();
      await expect(send()).rejects.toMatchObject({ status: 429 });

      expect(await sentCount()).toBe(2);
      expect(await usedQuota()).toBe(2);
    });

    it('counts a delivered message against the allowance', async () => {
      await seedClinicWithAllowance(5);

      await send();

      expect(await usedQuota()).toBe(1);
    });

    it('refuses everything when the plan includes no WhatsApp allowance', async () => {
      await seedClinicWithAllowance(0);

      await expect(send()).rejects.toMatchObject({ status: 403 });
      expect(await sentCount()).toBe(0);
    });
  });

  // ── The race ───────────────────────────────────────────────────────────────

  describe('concurrently', () => {
    it('never delivers more messages than the plan allows', async () => {
      const LIMIT = 3;
      const CONCURRENT = 10;
      await seedClinicWithAllowance(LIMIT);

      // All ten start before any of them finishes, which is exactly the
      // interleaving a burst of reminder sends produces in production.
      const results = await Promise.allSettled(
        Array.from({ length: CONCURRENT }, () => send()),
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
      const delivered = await sentCount();

      expect({ fulfilled, delivered }).toEqual({
        fulfilled: LIMIT,
        delivered: LIMIT,
      });
    });

    it('leaves the counter consistent with what was delivered', async () => {
      const LIMIT = 4;
      await seedClinicWithAllowance(LIMIT);

      await Promise.allSettled(Array.from({ length: 12 }, () => send()));

      expect(await usedQuota()).toBe(await sentCount());
      expect(await usedQuota()).toBeLessThanOrEqual(LIMIT);
    });

    it('refuses the excess with 429 rather than failing some other way', async () => {
      const LIMIT = 2;
      await seedClinicWithAllowance(LIMIT);

      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () => send()),
      );

      const rejections = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(rejections).toHaveLength(4);
      for (const rejection of rejections) {
        expect((rejection.reason as { status?: number }).status).toBe(429);
      }
    });

    it('still allows the full allowance — the guard does not over-refuse', async () => {
      const LIMIT = 5;
      await seedClinicWithAllowance(LIMIT);

      const results = await Promise.allSettled(
        Array.from({ length: LIMIT }, () => send()),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(
        LIMIT,
      );
    });
  });

  // ── A failed send must not consume allowance ───────────────────────────────

  describe('provider failure', () => {
    it('consumes no allowance when the provider rejects the message', async () => {
      await seedClinicWithAllowance(3);

      const provider = h.app.get<INotificationProvider>(NOTIFICATION_PROVIDER);
      const original = provider.send.bind(provider);
      provider.send = () =>
        Promise.reject(new Error('Meta rejected the template'));

      try {
        await send();
      } finally {
        provider.send = original;
      }

      expect(await usedQuota()).toBe(0);
      expect(await sentCount()).toBe(0);
      await expect(
        h.prisma.notificationMessage.count({
          where: { clinicId: CLINIC, status: 'FAILED' },
        }),
      ).resolves.toBe(1);
    });
  });
});
