import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';

import { NotificationService } from './notification.service';

/**
 * WhatsApp notifications.
 *
 * Three rules decide whether a message may leave the building, and all three
 * are load-bearing for cost and for LGPD compliance:
 *
 *   1. the plan must include WhatsApp, and it sets the monthly allowance;
 *   2. the clinic must not have exhausted that allowance;
 *   3. the recipient must have granted consent for this channel and scope.
 *
 * A provider failure must never be silent: the message is still recorded, as
 * FAILED, and no quota is consumed for a message that was never delivered.
 */

const CLINIC = 'clinic-1';
const ACTOR = 'user-1';

const UTILITY_TEMPLATE = {
  id: 'tpl-1',
  isActive: true,
  category: 'UTILITY',
  channel: 'WHATSAPP',
};

function createPrisma() {
  return {
    subscription: { findUnique: jest.fn().mockResolvedValue(null) },
    notificationQuota: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
      // The conditional claim: count 1 means a unit was reserved, 0 means the
      // allowance is already spent.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    notificationTemplate: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(UTILITY_TEMPLATE),
    },
    notificationPreference: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
    notificationConsent: {
      findFirst: jest.fn().mockResolvedValue({ id: 'consent-1' }),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'consent-1', granted: true }),
      update: jest.fn().mockResolvedValue({ id: 'consent-1', granted: false }),
    },
    notificationMessage: {
      create: jest.fn().mockResolvedValue({ id: 'msg-1', status: 'SENT' }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    appointment: {
      findUnique: jest.fn().mockResolvedValue({ clinicId: CLINIC }),
    },
  };
}

/** A plan that includes WhatsApp with the given allowance. */
function planWith(limit: number | null, slug = 'professional') {
  return {
    clinicId: CLINIC,
    plan: { slug, hasWhatsApp: true, whatsappMonthlyLimit: limit },
  };
}

describe('NotificationService', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let auditLog: { log: jest.Mock };
  let provider: { send: jest.Mock };
  let service: NotificationService;

  beforeEach(() => {
    prisma = createPrisma();
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };
    provider = {
      send: jest.fn().mockResolvedValue({ providerRef: 'wamid.1' }),
    };
    service = new NotificationService(
      prisma as never,
      auditLog as never,
      provider as never,
    );
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const sendDto = { templateSlug: 'reminder', phone: '11999998888' } as never;

  // ── Plan allowance ─────────────────────────────────────────────────────────

  describe('plan allowance', () => {
    it('allows nothing when the clinic has no subscription', async () => {
      const quota = await service.getQuota(CLINIC);
      expect(quota.limit).toBe(0);
    });

    it('uses the plan’s explicit monthly limit', async () => {
      prisma.subscription.findUnique.mockResolvedValue(planWith(120));
      expect((await service.getQuota(CLINIC)).limit).toBe(120);
    });

    it('falls back to the slug allowance when the plan states no limit', async () => {
      prisma.subscription.findUnique.mockResolvedValue(
        planWith(null, 'premium'),
      );
      expect((await service.getQuota(CLINIC)).limit).toBe(300);
    });

    it('falls back to the slug allowance for professional', async () => {
      prisma.subscription.findUnique.mockResolvedValue(
        planWith(null, 'professional'),
      );
      expect((await service.getQuota(CLINIC)).limit).toBe(50);
    });

    it('allows nothing for an unrecognised plan slug', async () => {
      prisma.subscription.findUnique.mockResolvedValue(
        planWith(null, 'mystery-tier'),
      );
      expect((await service.getQuota(CLINIC)).limit).toBe(0);
    });

    it('allows nothing when the plan does not include WhatsApp', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        clinicId: CLINIC,
        plan: {
          slug: 'starter',
          hasWhatsApp: false,
          whatsappMonthlyLimit: 999,
        },
      });
      // The flag wins over any stored limit.
      expect((await service.getQuota(CLINIC)).limit).toBe(0);
    });

    it('falls back by slug when a subscription has no plan at all', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        clinicId: CLINIC,
        plan: null,
      });
      expect((await service.getQuota(CLINIC)).limit).toBe(0);
    });
  });

  // ── Quota reporting ────────────────────────────────────────────────────────

  describe('getQuota', () => {
    it('reports zero usage before anything is sent', async () => {
      prisma.subscription.findUnique.mockResolvedValue(planWith(50));

      const quota = await service.getQuota(CLINIC);

      expect(quota.used).toBe(0);
      expect(quota.available).toBe(50);
      expect(quota.channel).toBe('WHATSAPP');
    });

    it('reports the remaining allowance', async () => {
      prisma.subscription.findUnique.mockResolvedValue(planWith(50));
      prisma.notificationQuota.findUnique.mockResolvedValue({ used: 20 });

      expect((await service.getQuota(CLINIC)).available).toBe(30);
    });

    it('never reports a negative allowance after a downgrade', async () => {
      // Usage can exceed a limit that shrank mid-month.
      prisma.subscription.findUnique.mockResolvedValue(planWith(10));
      prisma.notificationQuota.findUnique.mockResolvedValue({ used: 25 });

      const quota = await service.getQuota(CLINIC);
      expect(quota.used).toBe(25);
      expect(quota.available).toBe(0);
    });

    it('scopes the quota to the current calendar month', async () => {
      await service.getQuota(CLINIC);

      const where = prisma.notificationQuota.findUnique.mock.calls[0][0].where;
      expect(where.clinicId_month_channel.month).toMatch(/^\d{4}-\d{2}$/);
      expect(where.clinicId_month_channel.clinicId).toBe(CLINIC);
    });
  });

  // ── Send: preconditions ────────────────────────────────────────────────────

  describe('send preconditions', () => {
    beforeEach(() => {
      prisma.subscription.findUnique.mockResolvedValue(planWith(50));
    });

    it('rejects an unknown template', async () => {
      prisma.notificationTemplate.findUnique.mockResolvedValue(null);
      await expect(service.send(CLINIC, ACTOR, sendDto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects an inactive template', async () => {
      prisma.notificationTemplate.findUnique.mockResolvedValue({
        ...UTILITY_TEMPLATE,
        isActive: false,
      });
      await expect(service.send(CLINIC, ACTOR, sendDto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects a non-UTILITY template', async () => {
      // Marketing categories require a different consent basis.
      prisma.notificationTemplate.findUnique.mockResolvedValue({
        ...UTILITY_TEMPLATE,
        category: 'MARKETING',
      });
      await expect(service.send(CLINIC, ACTOR, sendDto)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('rejects an appointment belonging to another clinic', async () => {
      prisma.appointment.findUnique.mockResolvedValue({
        clinicId: 'other-clinic',
      });

      await expect(
        service.send(CLINIC, ACTOR, {
          ...(sendDto as object),
          appointmentId: 'a1',
        } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects an appointment that does not exist', async () => {
      prisma.appointment.findUnique.mockResolvedValue(null);

      await expect(
        service.send(CLINIC, ACTOR, {
          ...(sendDto as object),
          appointmentId: 'a1',
        } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it('does not look up an appointment when none was given', async () => {
      await service.send(CLINIC, ACTOR, sendDto);
      expect(prisma.appointment.findUnique).not.toHaveBeenCalled();
    });

    it('rejects a send when the plan excludes WhatsApp', async () => {
      prisma.subscription.findUnique.mockResolvedValue(null);
      await expect(service.send(CLINIC, ACTOR, sendDto)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('rejects a send once the monthly allowance is exhausted', async () => {
      // The conditional claim matches no row, so nothing was reserved.
      prisma.notificationQuota.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.send(CLINIC, ACTOR, sendDto)).rejects.toMatchObject({
        status: 429,
      });
    });

    it('names the limit in the exhaustion message', async () => {
      prisma.notificationQuota.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.send(CLINIC, ACTOR, sendDto)).rejects.toThrow(
        /50 mensagens/,
      );
    });

    it('does not contact the provider when nothing could be reserved', async () => {
      prisma.notificationQuota.updateMany.mockResolvedValue({ count: 0 });

      await service.send(CLINIC, ACTOR, sendDto).catch(() => undefined);

      expect(provider.send).not.toHaveBeenCalled();
    });

    it('rejects a send with no consent on file', async () => {
      prisma.notificationConsent.findFirst.mockResolvedValue(null);
      await expect(service.send(CLINIC, ACTOR, sendDto)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('looks for consent matching clinic, phone, channel and scope, not revoked', async () => {
      await service.send(CLINIC, ACTOR, sendDto);

      expect(
        prisma.notificationConsent.findFirst.mock.calls[0][0].where,
      ).toEqual({
        clinicId: CLINIC,
        phone: '11999998888',
        channel: 'WHATSAPP',
        scope: 'UTILITY',
        granted: true,
        revokedAt: null,
      });
    });

    it('normalises the phone number before matching consent', async () => {
      await service.send(CLINIC, ACTOR, {
        ...(sendDto as object),
        phone: '+55 (11) 99999-8888',
      } as never);

      expect(
        prisma.notificationConsent.findFirst.mock.calls[0][0].where.phone,
      ).toBe('5511999998888');
    });

    it('contacts the provider only after every check has passed', async () => {
      prisma.notificationConsent.findFirst.mockResolvedValue(null);
      await service.send(CLINIC, ACTOR, sendDto).catch(() => undefined);
      expect(provider.send).not.toHaveBeenCalled();
    });
  });

  // ── Send: outcome ──────────────────────────────────────────────────────────

  describe('send outcome', () => {
    beforeEach(() => {
      prisma.subscription.findUnique.mockResolvedValue(planWith(50));
    });

    it('records a sent message with the provider reference', async () => {
      await service.send(CLINIC, ACTOR, sendDto);

      const data = prisma.notificationMessage.create.mock.calls[0][0].data;
      expect(data.status).toBe('SENT');
      expect(data.providerRef).toBe('wamid.1');
      expect(data.sentAt).toBeInstanceOf(Date);
      expect(data.failedAt).toBeNull();
    });

    it('never stores the message body', async () => {
      await service.send(CLINIC, ACTOR, sendDto);

      const data = prisma.notificationMessage.create.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('body');
      expect(data).not.toHaveProperty('bodyPt');
    });

    it('claims one unit of quota, conditionally on the allowance', async () => {
      await service.send(CLINIC, ACTOR, sendDto);

      const args = prisma.notificationQuota.updateMany.mock.calls[0][0];
      expect(args.where).toMatchObject({
        clinicId: CLINIC,
        channel: 'WHATSAPP',
        used: { lt: 50 },
      });
      expect(args.data).toEqual({ used: { increment: 1 } });
    });

    it('claims the unit before contacting the provider, not after', async () => {
      // Reading the counter and incrementing afterwards leaves a window in
      // which concurrent sends all pass the same check; the conditional claim
      // is what actually enforces the limit.
      const order: string[] = [];
      prisma.notificationQuota.updateMany.mockImplementation(() => {
        order.push('reserve');
        return Promise.resolve({ count: 1 });
      });
      provider.send.mockImplementation(() => {
        order.push('send');
        return Promise.resolve({ providerRef: 'wamid.1' });
      });

      await service.send(CLINIC, ACTOR, sendDto);

      expect(order).toEqual(['reserve', 'send']);
    });

    it('records a failed message instead of throwing when the provider fails', async () => {
      provider.send.mockRejectedValue(new Error('Meta rejected the template'));

      const message = await service.send(CLINIC, ACTOR, sendDto);

      expect(message).toBeDefined();
      const data = prisma.notificationMessage.create.mock.calls[0][0].data;
      expect(data.status).toBe('FAILED');
      expect(data.failReason).toBe('Meta rejected the template');
      expect(data.failedAt).toBeInstanceOf(Date);
      expect(data.sentAt).toBeNull();
    });

    it('returns the reserved unit when the message was never delivered', async () => {
      provider.send.mockRejectedValue(new Error('boom'));

      await service.send(CLINIC, ACTOR, sendDto);

      // Claimed, then released — only a delivered message costs allowance.
      const calls = prisma.notificationQuota.updateMany.mock.calls;
      expect(calls[0][0].data).toEqual({ used: { increment: 1 } });
      expect(calls[1][0].data).toEqual({ used: { decrement: 1 } });
      expect(calls[1][0].where).toMatchObject({ used: { gt: 0 } });
    });

    it('keeps the released unit from driving the counter negative', async () => {
      provider.send.mockRejectedValue(new Error('boom'));

      await service.send(CLINIC, ACTOR, sendDto);

      const release = prisma.notificationQuota.updateMany.mock.calls[1][0];
      expect(release.where.used).toEqual({ gt: 0 });
    });

    it('records a generic reason when the provider throws a non-Error', async () => {
      provider.send.mockRejectedValue('just a string');

      await service.send(CLINIC, ACTOR, sendDto);

      expect(
        prisma.notificationMessage.create.mock.calls[0][0].data.failReason,
      ).toBe('Falha no provedor');
    });

    it('passes the resolved consent id to the provider', async () => {
      await service.send(CLINIC, ACTOR, sendDto);
      expect(provider.send).toHaveBeenCalledWith(
        expect.objectContaining({ clinicId: CLINIC, consentId: 'consent-1' }),
      );
    });

    it('audits the send with its outcome', async () => {
      await service.send(CLINIC, ACTOR, sendDto);

      expect(auditLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'NOTIFICATION_SENT',
          actorUserId: ACTOR,
          clinicId: CLINIC,
          metadata: expect.objectContaining({ status: 'SENT' }),
        }),
      );
    });

    it('marks the audit entry as simulated when the local provider is in use', async () => {
      await service.send(CLINIC, ACTOR, sendDto);

      expect(auditLog.log.mock.calls[0][0].metadata.simulated).toBe(true);
    });

    it('audits a failure as such', async () => {
      provider.send.mockRejectedValue(new Error('boom'));
      await service.send(CLINIC, ACTOR, sendDto);

      expect(auditLog.log.mock.calls[0][0].metadata.status).toBe('FAILED');
    });
  });

  // ── Consents ───────────────────────────────────────────────────────────────

  describe('consents', () => {
    const consentDto = {
      phone: '+55 (11) 99999-8888',
      channel: 'WHATSAPP',
      scope: 'UTILITY',
      granted: true,
      source: 'FORM',
    } as never;

    it('normalises the phone number before storing a new consent', async () => {
      prisma.notificationConsent.findFirst.mockResolvedValue(null);

      await service.createOrUpdateConsent(CLINIC, ACTOR, consentDto);

      expect(
        prisma.notificationConsent.create.mock.calls[0][0].data.phone,
      ).toBe('5511999998888');
    });

    it('stamps grantedAt and clears revokedAt when consent is granted', async () => {
      prisma.notificationConsent.findFirst.mockResolvedValue(null);

      await service.createOrUpdateConsent(CLINIC, ACTOR, consentDto);

      const data = prisma.notificationConsent.create.mock.calls[0][0].data;
      expect(data.grantedAt).toBeInstanceOf(Date);
      expect(data.revokedAt).toBeNull();
    });

    it('stamps revokedAt and leaves grantedAt null when consent is refused', async () => {
      prisma.notificationConsent.findFirst.mockResolvedValue(null);

      await service.createOrUpdateConsent(CLINIC, ACTOR, {
        ...(consentDto as object),
        granted: false,
      } as never);

      const data = prisma.notificationConsent.create.mock.calls[0][0].data;
      expect(data.grantedAt).toBeNull();
      expect(data.revokedAt).toBeInstanceOf(Date);
    });

    it('updates an existing consent rather than creating a duplicate', async () => {
      prisma.notificationConsent.findFirst.mockResolvedValue({
        id: 'existing',
        grantedAt: new Date('2026-01-01'),
      });

      await service.createOrUpdateConsent(CLINIC, ACTOR, consentDto);

      expect(prisma.notificationConsent.create).not.toHaveBeenCalled();
      expect(prisma.notificationConsent.update.mock.calls[0][0].where).toEqual({
        id: 'existing',
      });
    });

    it('re-stamps the grant date when consent is granted again', async () => {
      // A renewed grant is a new consent event, so it carries a new timestamp.
      const originalGrant = new Date('2026-01-01T00:00:00.000Z');
      prisma.notificationConsent.findFirst.mockResolvedValue({
        id: 'existing',
        grantedAt: originalGrant,
      });

      await service.createOrUpdateConsent(CLINIC, ACTOR, consentDto);

      const data = prisma.notificationConsent.update.mock.calls[0][0].data;
      expect(data.grantedAt).toBeInstanceOf(Date);
      expect(data.grantedAt.getTime()).toBeGreaterThan(originalGrant.getTime());
      expect(data.revokedAt).toBeNull();
    });

    it('keeps the original grant date on record when revoking', async () => {
      // Revocation must not erase the evidence that consent was once given.
      const originalGrant = new Date('2026-01-01T00:00:00.000Z');
      prisma.notificationConsent.findFirst.mockResolvedValue({
        id: 'existing',
        grantedAt: originalGrant,
      });

      await service.createOrUpdateConsent(CLINIC, ACTOR, {
        ...(consentDto as object),
        granted: false,
      } as never);

      const data = prisma.notificationConsent.update.mock.calls[0][0].data;
      expect(data.grantedAt).toBe(originalGrant);
      expect(data.revokedAt).toBeInstanceOf(Date);
    });

    it('audits a grant and a revocation differently', async () => {
      prisma.notificationConsent.findFirst.mockResolvedValue(null);

      await service.createOrUpdateConsent(CLINIC, ACTOR, consentDto);
      expect(auditLog.log.mock.calls[0][0].action).toBe(
        'NOTIFICATION_CONSENT_GRANTED',
      );

      auditLog.log.mockClear();
      await service.createOrUpdateConsent(CLINIC, ACTOR, {
        ...(consentDto as object),
        granted: false,
      } as never);
      expect(auditLog.log.mock.calls[0][0].action).toBe(
        'NOTIFICATION_CONSENT_REVOKED',
      );
    });

    it('refuses to revoke a consent belonging to another clinic', async () => {
      prisma.notificationConsent.findUnique.mockResolvedValue({
        id: 'c1',
        clinicId: 'other-clinic',
      });

      await expect(service.revokeConsent(CLINIC, 'c1', ACTOR)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.notificationConsent.update).not.toHaveBeenCalled();
    });

    it('refuses to revoke a consent that does not exist', async () => {
      prisma.notificationConsent.findUnique.mockResolvedValue(null);
      await expect(service.revokeConsent(CLINIC, 'c1', ACTOR)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('revokes its own clinic’s consent and stamps the time', async () => {
      prisma.notificationConsent.findUnique.mockResolvedValue({
        id: 'c1',
        clinicId: CLINIC,
        phone: '5511999998888',
        channel: 'WHATSAPP',
        scope: 'UTILITY',
      });

      await service.revokeConsent(CLINIC, 'c1', ACTOR);

      const data = prisma.notificationConsent.update.mock.calls[0][0].data;
      expect(data.granted).toBe(false);
      expect(data.revokedAt).toBeInstanceOf(Date);
    });

    it('scopes a consent listing to the clinic and normalises a phone filter', async () => {
      await service.listConsents(CLINIC, { phone: '(11) 99999-8888' } as never);

      expect(
        prisma.notificationConsent.findMany.mock.calls[0][0].where,
      ).toEqual({
        clinicId: CLINIC,
        phone: '11999998888',
      });
    });

    it('applies channel and scope filters when given', async () => {
      await service.listConsents(CLINIC, {
        channel: 'WHATSAPP',
        scope: 'UTILITY',
      } as never);

      expect(
        prisma.notificationConsent.findMany.mock.calls[0][0].where,
      ).toMatchObject({
        channel: 'WHATSAPP',
        scope: 'UTILITY',
      });
    });
  });

  // ── Preferences ────────────────────────────────────────────────────────────

  describe('preferences', () => {
    it('returns safe defaults for a clinic that has never set them', async () => {
      const prefs = await service.getPreferences(CLINIC);

      expect(prefs).toMatchObject({
        clinicId: CLINIC,
        whatsappEnabled: false,
        autoReminder: false,
        autoConfirmation: false,
        reminderHoursBefore: 24,
      });
    });

    it('reports the provider type and whether it is configured', async () => {
      const prefs = await service.getPreferences(CLINIC);
      expect(prefs.providerType).toBe('local');
      expect(prefs.providerConfigured).toBe(false);
    });

    it('updates only the fields that were supplied', async () => {
      await service.updatePreferences(CLINIC, { autoReminder: true } as never);

      expect(
        prisma.notificationPreference.upsert.mock.calls[0][0].update,
      ).toEqual({
        autoReminder: true,
      });
    });

    it('keeps a false value rather than treating it as absent', async () => {
      await service.updatePreferences(CLINIC, {
        whatsappEnabled: false,
      } as never);

      expect(
        prisma.notificationPreference.upsert.mock.calls[0][0].update,
      ).toEqual({ whatsappEnabled: false });
    });

    it('creates with defaults for anything the caller omitted', async () => {
      await service.updatePreferences(CLINIC, { autoReminder: true } as never);

      expect(
        prisma.notificationPreference.upsert.mock.calls[0][0].create,
      ).toEqual({
        clinicId: CLINIC,
        whatsappEnabled: false,
        autoReminder: true,
        autoConfirmation: false,
        reminderHoursBefore: 24,
      });
    });
  });

  // ── Messages ───────────────────────────────────────────────────────────────

  describe('listMessages', () => {
    it('scopes to the clinic and defaults to twenty per page', async () => {
      const result = await service.listMessages(CLINIC, {} as never);

      expect(
        prisma.notificationMessage.findMany.mock.calls[0][0],
      ).toMatchObject({
        where: { clinicId: CLINIC },
        skip: 0,
        take: 20,
      });
      expect(result.page).toBe(1);
    });

    it('caps the page size at one hundred', async () => {
      const result = await service.listMessages(CLINIC, {
        limit: 500,
      } as never);
      expect(result.limit).toBe(100);
    });

    it('filters by appointment when asked', async () => {
      await service.listMessages(CLINIC, { appointmentId: 'a1' } as never);

      expect(
        prisma.notificationMessage.findMany.mock.calls[0][0].where,
      ).toEqual({
        clinicId: CLINIC,
        appointmentId: 'a1',
      });
    });

    it('reports the total page count', async () => {
      prisma.notificationMessage.count.mockResolvedValue(41);
      const result = await service.listMessages(CLINIC, { limit: 20 } as never);
      expect(result.totalPages).toBe(3);
    });

    it('uses the same filter for the page and its count', async () => {
      await service.listMessages(CLINIC, { appointmentId: 'a1' } as never);

      expect(prisma.notificationMessage.count.mock.calls[0][0].where).toEqual(
        prisma.notificationMessage.findMany.mock.calls[0][0].where,
      );
    });
  });

  // ── Templates ──────────────────────────────────────────────────────────────

  describe('listTemplates', () => {
    it('offers only active UTILITY templates', async () => {
      await service.listTemplates();

      expect(
        prisma.notificationTemplate.findMany.mock.calls[0][0].where,
      ).toEqual({
        isActive: true,
        category: 'UTILITY',
      });
    });
  });
});
