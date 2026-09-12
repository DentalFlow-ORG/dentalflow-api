import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrivacyRequestStatus, UserRole } from '@prisma/client';

import { PrivacyService } from './privacy.service';
import type { AuthUser } from '../../common/types/auth-user.type';

/**
 * LGPD data-subject requests and cookie-consent logging.
 *
 * Two properties carry the compliance weight: the request register is
 * ADMIN-only (there is no clinicId on PrivacyRequest yet, so it cannot be
 * safely scoped to an OWNER), and the consent log must retain proof of consent
 * without retaining a raw IP address.
 */

const ADMIN: AuthUser = { id: 'admin-1', clinicId: null, role: UserRole.ADMIN };
const OWNER: AuthUser = {
  id: 'owner-1',
  clinicId: 'clinic-1',
  role: UserRole.OWNER,
};
const DENTIST: AuthUser = {
  id: 'dentist-1',
  clinicId: 'clinic-1',
  role: UserRole.DENTIST,
};
const ASSISTANT: AuthUser = {
  id: 'assistant-1',
  clinicId: 'clinic-1',
  role: UserRole.ASSISTANT,
};

function createPrisma() {
  return {
    privacyRequest: {
      create: jest.fn().mockResolvedValue({
        id: 'req-1',
        requestCode: 'PR-ABCD1234',
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
      }),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue({ id: 'req-1' }),
    },
    cookieConsentLog: {
      create: jest.fn().mockResolvedValue({ id: 'log-1' }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
  };
}

const VALID_REQUEST = {
  requesterName: 'Maria Silva',
  requesterEmail: 'maria@example.test',
  requesterType: 'PATIENT',
  clinicName: 'Alpha Odonto',
  requestType: 'ACCESS',
  description: 'Quero uma cópia dos meus dados.',
  identityConfirmationAccepted: true,
} as never;

describe('PrivacyService', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let auditLog: { log: jest.Mock };
  let service: PrivacyService;

  beforeEach(() => {
    prisma = createPrisma();
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };
    service = new PrivacyService(prisma as never, auditLog as never);
  });

  // ── createRequest (public) ─────────────────────────────────────────────────

  describe('createRequest', () => {
    it('refuses a request without an identity-verification confirmation', async () => {
      await expect(
        service.createRequest(
          {
            ...(VALID_REQUEST as object),
            identityConfirmationAccepted: false,
          } as never,
          {},
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('writes nothing when identity confirmation is missing', async () => {
      await service
        .createRequest(
          {
            ...(VALID_REQUEST as object),
            identityConfirmationAccepted: false,
          } as never,
          {},
        )
        .catch(() => undefined);

      expect(prisma.privacyRequest.create).not.toHaveBeenCalled();
      expect(auditLog.log).not.toHaveBeenCalled();
    });

    it('returns the tracking code the requester needs to follow up', async () => {
      const result = await service.createRequest(VALID_REQUEST, {});

      expect(result.requestCode).toBe('PR-ABCD1234');
      expect(result.message).toContain('PR-');
    });

    it('opens the request in the OPEN state', async () => {
      await service.createRequest(VALID_REQUEST, {});

      expect(prisma.privacyRequest.create.mock.calls[0][0].data.status).toBe(
        'OPEN',
      );
    });

    it('generates a prefixed, unique-looking request code', async () => {
      await service.createRequest(VALID_REQUEST, {});
      const first =
        prisma.privacyRequest.create.mock.calls[0][0].data.requestCode;

      await service.createRequest(VALID_REQUEST, {});
      const second =
        prisma.privacyRequest.create.mock.calls[1][0].data.requestCode;

      expect(first).toMatch(/^PR-[0-9A-F]{8}$/);
      expect(first).not.toBe(second);
    });

    it('stores a null clinic name when none was supplied', async () => {
      await service.createRequest(
        { ...(VALID_REQUEST as object), clinicName: undefined } as never,
        {},
      );

      expect(
        prisma.privacyRequest.create.mock.calls[0][0].data.clinicName,
      ).toBeNull();
    });

    it('records an audit entry with the request metadata', async () => {
      await service.createRequest(VALID_REQUEST, {
        ipAddress: '203.0.113.10',
        userAgent: 'Mozilla/5.0',
      });

      expect(auditLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PRIVACY_REQUEST_CREATED',
          entityType: 'PrivacyRequest',
          entityId: 'req-1',
          ipAddress: '203.0.113.10',
        }),
      );
    });

    it('does not put the requester’s description into the audit metadata', async () => {
      await service.createRequest(VALID_REQUEST, {});

      const metadata = auditLog.log.mock.calls[0][0].metadata;
      expect(JSON.stringify(metadata)).not.toContain('cópia dos meus dados');
    });
  });

  // ── Authorization ──────────────────────────────────────────────────────────

  describe('authorization', () => {
    it.each([
      ['OWNER', OWNER],
      ['DENTIST', DENTIST],
      ['ASSISTANT', ASSISTANT],
    ])('refuses %s access to the request register', async (_name, actor) => {
      await expect(service.listRequests(actor)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('allows ADMIN to list requests', async () => {
      await expect(service.listRequests(ADMIN)).resolves.toBeDefined();
    });

    it('refuses a non-ADMIN reading a single request', async () => {
      await expect(service.getRequest('req-1', OWNER)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('checks the role before querying, so a non-ADMIN learns nothing from the response', async () => {
      await service.getRequest('req-1', OWNER).catch(() => undefined);
      expect(prisma.privacyRequest.findUnique).not.toHaveBeenCalled();
    });

    it('refuses a non-ADMIN status change and writes nothing', async () => {
      prisma.privacyRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        requestCode: 'PR-1',
        status: 'OPEN',
      });

      await expect(
        service.updateStatus(
          'req-1',
          { status: PrivacyRequestStatus.COMPLETED } as never,
          OWNER,
          {},
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.privacyRequest.update).not.toHaveBeenCalled();
    });

    it('refuses a non-ADMIN response and writes nothing', async () => {
      prisma.privacyRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        requestCode: 'PR-1',
      });

      await expect(
        service.respondToRequest('req-1', 'Dados enviados.', DENTIST, {}),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.privacyRequest.update).not.toHaveBeenCalled();
    });
  });

  // ── listRequests ───────────────────────────────────────────────────────────

  describe('listRequests', () => {
    it('defaults to the first page of twenty', async () => {
      const result = await service.listRequests(ADMIN);

      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(prisma.privacyRequest.findMany.mock.calls[0][0]).toMatchObject({
        skip: 0,
        take: 20,
      });
    });

    it('caps the page size at one hundred', async () => {
      const result = await service.listRequests(ADMIN, {
        limit: 5000,
      } as never);
      expect(result.limit).toBe(100);
    });

    it('skips by page', async () => {
      await service.listRequests(ADMIN, { page: 3, limit: 10 } as never);
      expect(prisma.privacyRequest.findMany.mock.calls[0][0].skip).toBe(20);
    });

    it('reports the total page count', async () => {
      prisma.privacyRequest.count.mockResolvedValue(45);
      const result = await service.listRequests(ADMIN, { limit: 20 } as never);
      expect(result.totalPages).toBe(3);
    });

    it('reports zero pages for an empty register', async () => {
      const result = await service.listRequests(ADMIN);
      expect(result.totalPages).toBe(0);
    });

    it('filters by status, type and requester type', async () => {
      await service.listRequests(ADMIN, {
        status: 'OPEN',
        requestType: 'ACCESS',
        requesterType: 'PATIENT',
      } as never);

      expect(
        prisma.privacyRequest.findMany.mock.calls[0][0].where,
      ).toMatchObject({
        status: 'OPEN',
        requestType: 'ACCESS',
        requesterType: 'PATIENT',
      });
    });

    it('searches code, email and name together, case-insensitively', async () => {
      await service.listRequests(ADMIN, { search: 'maria' } as never);

      const where = prisma.privacyRequest.findMany.mock.calls[0][0].where;
      expect(where.OR).toEqual([
        { requestCode: { contains: 'maria', mode: 'insensitive' } },
        { requesterEmail: { contains: 'maria', mode: 'insensitive' } },
        { requesterName: { contains: 'maria', mode: 'insensitive' } },
      ]);
    });

    it('applies no filter when none is supplied', async () => {
      await service.listRequests(ADMIN);
      expect(prisma.privacyRequest.findMany.mock.calls[0][0].where).toEqual({});
    });

    it('omits the free-text description from the list projection', async () => {
      await service.listRequests(ADMIN);

      const select = prisma.privacyRequest.findMany.mock.calls[0][0].select;
      expect(select).not.toHaveProperty('description');
      expect(select).not.toHaveProperty('responseNotes');
    });

    it('uses the same filter for the page and its count', async () => {
      await service.listRequests(ADMIN, { status: 'OPEN' } as never);

      expect(prisma.privacyRequest.count.mock.calls[0][0].where).toEqual(
        prisma.privacyRequest.findMany.mock.calls[0][0].where,
      );
    });
  });

  // ── getRequest ─────────────────────────────────────────────────────────────

  describe('getRequest', () => {
    it('returns the request for an ADMIN', async () => {
      prisma.privacyRequest.findUnique.mockResolvedValue({ id: 'req-1' });
      await expect(service.getRequest('req-1', ADMIN)).resolves.toEqual({
        id: 'req-1',
      });
    });

    it('answers 404 for an unknown request', async () => {
      await expect(service.getRequest('missing', ADMIN)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── updateStatus ───────────────────────────────────────────────────────────

  describe('updateStatus', () => {
    beforeEach(() => {
      prisma.privacyRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        requestCode: 'PR-1',
        status: 'OPEN',
      });
    });

    it('answers 404 for an unknown request', async () => {
      prisma.privacyRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.updateStatus(
          'missing',
          { status: PrivacyRequestStatus.IN_REVIEW } as never,
          ADMIN,
          {},
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('stamps completedAt when the request is completed', async () => {
      await service.updateStatus(
        'req-1',
        { status: PrivacyRequestStatus.COMPLETED } as never,
        ADMIN,
        {},
      );

      expect(
        prisma.privacyRequest.update.mock.calls[0][0].data.completedAt,
      ).toBeInstanceOf(Date);
    });

    it('stamps completedAt when the request is rejected', async () => {
      await service.updateStatus(
        'req-1',
        { status: PrivacyRequestStatus.REJECTED } as never,
        ADMIN,
        {},
      );

      expect(
        prisma.privacyRequest.update.mock.calls[0][0].data.completedAt,
      ).toBeInstanceOf(Date);
    });

    it('leaves completedAt untouched for a non-terminal status', async () => {
      await service.updateStatus(
        'req-1',
        { status: PrivacyRequestStatus.IN_REVIEW } as never,
        ADMIN,
        {},
      );

      expect(
        prisma.privacyRequest.update.mock.calls[0][0].data.completedAt,
      ).toBeUndefined();
    });

    it('leaves existing notes alone when none are supplied', async () => {
      await service.updateStatus(
        'req-1',
        { status: PrivacyRequestStatus.IN_REVIEW } as never,
        ADMIN,
        {},
      );

      expect(
        prisma.privacyRequest.update.mock.calls[0][0].data.responseNotes,
      ).toBeUndefined();
    });

    it('records both the previous and the new status in the audit trail', async () => {
      await service.updateStatus(
        'req-1',
        { status: PrivacyRequestStatus.COMPLETED } as never,
        ADMIN,
        {},
      );

      expect(auditLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: ADMIN.id,
          action: 'PRIVACY_REQUEST_STATUS_CHANGED',
          metadata: expect.objectContaining({
            previousStatus: 'OPEN',
            newStatus: PrivacyRequestStatus.COMPLETED,
          }),
        }),
      );
    });
  });

  // ── respondToRequest ───────────────────────────────────────────────────────

  describe('respondToRequest', () => {
    beforeEach(() => {
      prisma.privacyRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        requestCode: 'PR-1',
      });
    });

    it('answers 404 for an unknown request', async () => {
      prisma.privacyRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.respondToRequest('missing', 'nota', ADMIN, {}),
      ).rejects.toThrow(NotFoundException);
    });

    it('completes the request and stamps completedAt', async () => {
      await service.respondToRequest('req-1', 'Dados enviados.', ADMIN, {});

      const data = prisma.privacyRequest.update.mock.calls[0][0].data;
      expect(data.status).toBe(PrivacyRequestStatus.COMPLETED);
      expect(data.responseNotes).toBe('Dados enviados.');
      expect(data.completedAt).toBeInstanceOf(Date);
    });

    it('records who responded', async () => {
      await service.respondToRequest('req-1', 'Dados enviados.', ADMIN, {});

      expect(auditLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: ADMIN.id,
          action: 'PRIVACY_REQUEST_RESPONDED',
        }),
      );
    });
  });

  // ── Cookie consent ─────────────────────────────────────────────────────────

  describe('logCookieConsent', () => {
    const CONSENT = {
      anonymousId: 'anon-1',
      categories: { necessary: true, analytics: false },
      policyVersion: '2026-01',
      source: 'BANNER',
    } as never;

    it('stores a hash of the IP address, never the address itself', async () => {
      await service.logCookieConsent(CONSENT, { ipAddress: '203.0.113.10' });

      const data = prisma.cookieConsentLog.create.mock.calls[0][0].data;
      expect(data.ipHash).toMatch(/^[0-9a-f]{16}$/);
      expect(data.ipHash).not.toContain('203.0.113.10');
    });

    it('hashes the same address to the same value so repeat consents can be correlated', async () => {
      await service.logCookieConsent(CONSENT, { ipAddress: '203.0.113.10' });
      await service.logCookieConsent(CONSENT, { ipAddress: '203.0.113.10' });

      const [first, second] = prisma.cookieConsentLog.create.mock.calls.map(
        ([args]: any) => args.data.ipHash,
      );
      expect(first).toBe(second);
    });

    it('hashes different addresses to different values', async () => {
      await service.logCookieConsent(CONSENT, { ipAddress: '203.0.113.10' });
      await service.logCookieConsent(CONSENT, { ipAddress: '203.0.113.11' });

      const [first, second] = prisma.cookieConsentLog.create.mock.calls.map(
        ([args]: any) => args.data.ipHash,
      );
      expect(first).not.toBe(second);
    });

    it('stores no IP hash when no address was seen', async () => {
      await service.logCookieConsent(CONSENT, {});
      expect(
        prisma.cookieConsentLog.create.mock.calls[0][0].data.ipHash,
      ).toBeUndefined();
    });

    it('truncates an oversized user agent rather than rejecting the consent', async () => {
      await service.logCookieConsent(CONSENT, { userAgent: 'x'.repeat(2000) });

      const data = prisma.cookieConsentLog.create.mock.calls[0][0].data;
      expect(data.userAgent).toHaveLength(512);
    });

    it('keeps a short user agent intact', async () => {
      await service.logCookieConsent(CONSENT, { userAgent: 'Mozilla/5.0' });
      expect(
        prisma.cookieConsentLog.create.mock.calls[0][0].data.userAgent,
      ).toBe('Mozilla/5.0');
    });

    it('stores no user agent when none was sent', async () => {
      await service.logCookieConsent(CONSENT, {});
      expect(
        prisma.cookieConsentLog.create.mock.calls[0][0].data.userAgent,
      ).toBeUndefined();
    });

    it('links the consent to the signed-in user when there is one', async () => {
      await service.logCookieConsent(CONSENT, { userId: 'user-9' });
      expect(prisma.cookieConsentLog.create.mock.calls[0][0].data.userId).toBe(
        'user-9',
      );
    });

    it('records an anonymous consent with a null user', async () => {
      await service.logCookieConsent(CONSENT, {});
      expect(
        prisma.cookieConsentLog.create.mock.calls[0][0].data.userId,
      ).toBeNull();
    });

    it('records a null anonymousId when the banner did not supply one', async () => {
      await service.logCookieConsent(
        { ...(CONSENT as object), anonymousId: undefined } as never,
        {},
      );
      expect(
        prisma.cookieConsentLog.create.mock.calls[0][0].data.anonymousId,
      ).toBeNull();
    });

    it('audits the consent with its policy version', async () => {
      await service.logCookieConsent(CONSENT, { userId: 'user-9' });

      expect(auditLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'COOKIE_CONSENT_RECORDED',
          actorUserId: 'user-9',
          metadata: expect.objectContaining({ policyVersion: '2026-01' }),
        }),
      );
    });
  });

  // ── listCookieConsents ─────────────────────────────────────────────────────

  describe('listCookieConsents', () => {
    it('filters by source, policy version and user', async () => {
      await service.listCookieConsents({
        source: 'BANNER',
        policyVersion: '2026-01',
        userId: 'user-9',
      } as never);

      expect(
        prisma.cookieConsentLog.findMany.mock.calls[0][0].where,
      ).toMatchObject({
        source: 'BANNER',
        policyVersion: '2026-01',
        userId: 'user-9',
      });
    });

    it('applies Brazil-midnight boundaries to a date range', async () => {
      await service.listCookieConsents({
        dateFrom: '2026-06-01',
        dateTo: '2026-06-30',
      } as never);

      const where = prisma.cookieConsentLog.findMany.mock.calls[0][0].where;
      expect(where.createdAt.gte.toISOString()).toBe(
        '2026-06-01T03:00:00.000Z',
      );
      expect(where.createdAt.lt).toBeInstanceOf(Date);
    });

    it('accepts an open-ended range', async () => {
      await service.listCookieConsents({ dateFrom: '2026-06-01' } as never);

      const where = prisma.cookieConsentLog.findMany.mock.calls[0][0].where;
      expect(where.createdAt).toHaveProperty('gte');
      expect(where.createdAt).not.toHaveProperty('lt');
    });

    it('omits the date filter entirely when no bound is supplied', async () => {
      await service.listCookieConsents({} as never);
      expect(prisma.cookieConsentLog.findMany.mock.calls[0][0].where).toEqual(
        {},
      );
    });

    it('never projects the stored user agent into the compliance dashboard', async () => {
      await service.listCookieConsents({} as never);

      const select = prisma.cookieConsentLog.findMany.mock.calls[0][0].select;
      expect(select).not.toHaveProperty('userAgent');
      expect(select.ipHash).toBe(true);
    });

    it('caps the page size at one hundred', async () => {
      const result = await service.listCookieConsents({ limit: 9999 } as never);
      expect(result.limit).toBe(100);
    });

    it('reports the total page count', async () => {
      prisma.cookieConsentLog.count.mockResolvedValue(21);
      const result = await service.listCookieConsents({ limit: 20 } as never);
      expect(result.totalPages).toBe(2);
    });
  });
});
