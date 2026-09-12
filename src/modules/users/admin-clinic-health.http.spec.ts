import { createHarness, Harness, USERS } from '../../../test/support/http-harness';

/**
 * REGRESSION — GET /admin/users/clinics/health
 *
 * A platform-wide aggregation that deliberately steps outside tenant scoping,
 * because a platform ADMIN needs cross-clinic visibility. That makes three
 * properties load-bearing, and each is pinned here:
 *
 *   1. Authorization — ADMIN only. Every clinic role, and anonymous, denied.
 *   2. Privacy — clinic and subscription health only. No patient identifiers,
 *      no clinical content, no appointment detail; appointments appear as
 *      counts and nothing else.
 *   3. Query strategy — a fixed number of grouped queries regardless of how
 *      many clinics exist. A per-clinic fan-out would degrade linearly with
 *      platform growth, which is exactly the shape that passes a two-row
 *      fixture and falls over in production.
 */

const PATH = '/admin/users/clinics/health';

const CLINIC_FULL = 'clinic-full';
const CLINIC_BARE = 'clinic-bare';

function clinicRows() {
  return [
    {
      id: CLINIC_FULL,
      name: 'Alpha Odonto',
      email: 'alpha@example.test',
      isActive: true,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    {
      id: CLINIC_BARE,
      name: 'Beta Odonto',
      email: 'beta@example.test',
      isActive: false,
      createdAt: new Date('2026-02-01T00:00:00.000Z'),
    },
  ];
}

describe('ADMIN clinic health', () => {
  let harness: Harness;
  let adminToken: string;

  beforeAll(async () => {
    harness = await createHarness();
    adminToken = harness.tokenFor(USERS.admin);
  }, 120_000);

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    harness.prisma.__reset();
  });

  // ── Authorization ──────────────────────────────────────────────────────────

  describe('authorization', () => {
    it('rejects an unauthenticated request with 401', async () => {
      const res = await harness.get(PATH);
      expect(res.status).toBe(401);
    });

    it.each([
      ['OWNER', USERS.ownerA],
      ['DENTIST', USERS.dentistA],
      ['ASSISTANT', USERS.assistantA],
    ])('rejects %s with 403', async (_name, user) => {
      const token = harness.tokenFor(user);
      const res = await harness.get(PATH).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain('Alpha Odonto');
    });

    it('rejects an ADMIN token that claims clinic membership', async () => {
      // assertPlatformAdmin re-checks the role/tenant shape rather than
      // trusting @Roles('ADMIN') alone.
      const token = harness.tokenFor({
        id: 'admin-with-clinic',
        clinicId: CLINIC_FULL,
        role: 'ADMIN',
      });
      const res = await harness.get(PATH).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it('allows ADMIN', async () => {
      harness.prisma.clinic.findMany.mockResolvedValue([]);
      const res = await harness.get(PATH).set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
    });
  });

  // ── Routing ────────────────────────────────────────────────────────────────

  it('is not shadowed by the GET /admin/users/:id route', async () => {
    harness.prisma.clinic.findMany.mockResolvedValue([]);
    const res = await harness.get(PATH).set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // The :id handler would have looked a user up instead.
    const userLookups = harness.prisma
      .__calls()
      .filter((c) => c.model === 'user' && c.operation === 'findFirst');
    expect(userLookups).toEqual([]);
  });

  // ── Aggregation ────────────────────────────────────────────────────────────

  describe('aggregation', () => {
    const loginAt = new Date('2026-03-10T12:00:00.000Z');
    const auditAt = new Date('2026-03-11T12:00:00.000Z');

    function seedFullPlatform() {
      harness.prisma.clinic.findMany.mockResolvedValue(clinicRows());
      harness.prisma.subscription.findMany.mockResolvedValue([
        {
          clinicId: CLINIC_FULL,
          status: 'ACTIVE',
          trialEndsAt: null,
          billingInterval: 'MONTHLY',
          createdAt: new Date('2026-01-05T00:00:00.000Z'),
          plan: { name: 'Professional', slug: 'professional' },
        },
      ]);
      harness.prisma.profile.groupBy.mockResolvedValue([
        { clinicId: CLINIC_FULL, _count: { _all: 3 } },
      ]);
      harness.prisma.clinicFiscalProfile.findMany.mockResolvedValue([
        { clinicId: CLINIC_FULL, isConfigured: true },
      ]);
      harness.prisma.auditLog.groupBy.mockResolvedValue([
        { clinicId: CLINIC_FULL, _max: { createdAt: auditAt } },
      ]);
      harness.prisma.user.groupBy.mockImplementation((args: any) => {
        if (args?._max?.lastLoginAt) {
          return Promise.resolve([
            { clinicId: CLINIC_FULL, _max: { lastLoginAt: loginAt } },
          ]);
        }
        return Promise.resolve([{ clinicId: CLINIC_FULL, _count: { _all: 5 } }]);
      });
      harness.prisma.appointment.groupBy.mockImplementation((args: any) => {
        const recent = args?.where?.appointmentDate !== undefined;
        return Promise.resolve([
          { clinicId: CLINIC_FULL, _count: { _all: recent ? 7 : 42 } },
        ]);
      });
    }

    it('excludes soft-deleted clinics', async () => {
      harness.prisma.clinic.findMany.mockResolvedValue([]);
      await harness.get(PATH).set('Authorization', `Bearer ${adminToken}`);

      const call = harness.prisma.clinic.findMany.mock.calls[0][0];
      expect(call.where).toEqual({ deletedAt: null });
    });

    it('returns an empty list and issues no aggregate queries when no clinic exists', async () => {
      harness.prisma.clinic.findMany.mockResolvedValue([]);
      const res = await harness.get(PATH).set('Authorization', `Bearer ${adminToken}`);

      expect(res.body).toEqual([]);
      expect(harness.prisma.subscription.findMany).not.toHaveBeenCalled();
      expect(harness.prisma.appointment.groupBy).not.toHaveBeenCalled();
    });

    it('reports counts, subscription, activity and fiscal state for a populated clinic', async () => {
      seedFullPlatform();
      const res = await harness.get(PATH).set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const full = res.body.find((row: any) => row.clinic.id === CLINIC_FULL);

      expect(full.clinic).toEqual({
        id: CLINIC_FULL,
        name: 'Alpha Odonto',
        email: 'alpha@example.test',
        isActive: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      expect(full.subscription).toEqual({
        planSlug: 'professional',
        planName: 'Professional',
        status: 'ACTIVE',
        trialEndsAt: null,
        billingInterval: 'MONTHLY',
        createdAt: '2026-01-05T00:00:00.000Z',
      });
      expect(full.counts).toEqual({
        dentists: 3,
        activeUsers: 5,
        totalAppointments: 42,
        recentAppointments: 7,
      });
      expect(full.compliance).toEqual({ fiscalSetupComplete: true });
    });

    it('reports a clinic with no subscription, no fiscal profile and no appointments as zeroed rather than omitted', async () => {
      seedFullPlatform();
      const res = await harness.get(PATH).set('Authorization', `Bearer ${adminToken}`);

      const bare = res.body.find((row: any) => row.clinic.id === CLINIC_BARE);
      expect(bare).toBeDefined();
      expect(bare.subscription).toBeNull();
      expect(bare.counts).toEqual({
        dentists: 0,
        activeUsers: 0,
        totalAppointments: 0,
        recentAppointments: 0,
      });
      expect(bare.compliance).toEqual({ fiscalSetupComplete: null });
      expect(bare.lastActivity).toEqual({ timestamp: null, source: null });
    });

    it('counts only appointments from the last 30 days as recent', async () => {
      seedFullPlatform();
      const before = Date.now();
      await harness.get(PATH).set('Authorization', `Bearer ${adminToken}`);

      const recentCall = harness.prisma.appointment.groupBy.mock.calls.find(
        ([args]: any) => args?.where?.appointmentDate !== undefined,
      );
      const cutoff: Date = recentCall[0].where.appointmentDate.gte;
      const daysBack = (before - cutoff.getTime()) / (24 * 60 * 60 * 1000);
      expect(daysBack).toBeCloseTo(30, 1);
    });

    it('prefers the most recent of login and audit activity', async () => {
      seedFullPlatform();
      const res = await harness.get(PATH).set('Authorization', `Bearer ${adminToken}`);

      const full = res.body.find((row: any) => row.clinic.id === CLINIC_FULL);
      // auditAt is the later of the two.
      expect(full.lastActivity).toEqual({
        timestamp: auditAt.toISOString(),
        source: 'AUDIT_LOG',
      });
    });

    it('reports USER_LOGIN when the last login is the more recent signal', async () => {
      seedFullPlatform();
      harness.prisma.auditLog.groupBy.mockResolvedValue([
        { clinicId: CLINIC_FULL, _max: { createdAt: new Date('2026-01-01T00:00:00.000Z') } },
      ]);

      const res = await harness.get(PATH).set('Authorization', `Bearer ${adminToken}`);
      const full = res.body.find((row: any) => row.clinic.id === CLINIC_FULL);
      expect(full.lastActivity).toEqual({
        timestamp: loginAt.toISOString(),
        source: 'USER_LOGIN',
      });
    });

    it('falls back to audit activity when a clinic has never had a login', async () => {
      seedFullPlatform();
      harness.prisma.user.groupBy.mockImplementation((args: any) =>
        Promise.resolve(
          args?._max?.lastLoginAt
            ? [{ clinicId: CLINIC_FULL, _max: { lastLoginAt: null } }]
            : [{ clinicId: CLINIC_FULL, _count: { _all: 5 } }],
        ),
      );

      const res = await harness.get(PATH).set('Authorization', `Bearer ${adminToken}`);
      const full = res.body.find((row: any) => row.clinic.id === CLINIC_FULL);
      expect(full.lastActivity).toEqual({
        timestamp: auditAt.toISOString(),
        source: 'AUDIT_LOG',
      });
    });

    it('counts only active, non-deleted users', async () => {
      seedFullPlatform();
      await harness.get(PATH).set('Authorization', `Bearer ${adminToken}`);

      const countCall = harness.prisma.user.groupBy.mock.calls.find(
        ([args]: any) => args?._count !== undefined,
      );
      expect(countCall[0].where).toMatchObject({ isActive: true, deletedAt: null });
    });
  });

  // ── Performance ────────────────────────────────────────────────────────────

  describe('query strategy', () => {
    function seedClinics(count: number) {
      const rows = Array.from({ length: count }, (_, i) => ({
        id: `clinic-${i}`,
        name: `Clinic ${i}`,
        email: `c${i}@example.test`,
        isActive: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      }));
      harness.prisma.clinic.findMany.mockResolvedValue(rows);
    }

    async function queryCountFor(clinicCount: number): Promise<number> {
      harness.prisma.__reset();
      seedClinics(clinicCount);
      await harness.get(PATH).set('Authorization', `Bearer ${adminToken}`);
      return harness.prisma
        .__calls()
        .filter((c) => !(c.model === 'user' && c.operation === 'findUnique')).length;
    }

    it('issues the same number of queries for 2 clinics as for 50 (no per-clinic fan-out)', async () => {
      const forTwo = await queryCountFor(2);
      const forFifty = await queryCountFor(50);

      expect(forTwo).toBe(forFifty);
      // One clinic list + eight grouped metric queries.
      expect(forFifty).toBe(9);
    });
  });

  // ── Privacy ────────────────────────────────────────────────────────────────

  describe('privacy', () => {
    it('never selects patient, clinical or appointment-detail fields', async () => {
      harness.prisma.clinic.findMany.mockResolvedValue(clinicRows());
      await harness.get(PATH).set('Authorization', `Bearer ${adminToken}`);

      const serialized = JSON.stringify(harness.prisma.__calls());
      for (const forbidden of [
        'patientName',
        'patientEmail',
        'patientPhone',
        'clinicalRecord',
        'anamnesis',
        'chiefComplaint',
        'odontogram',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    });

    it('exposes appointments only as counts', async () => {
      harness.prisma.clinic.findMany.mockResolvedValue(clinicRows());
      harness.prisma.appointment.groupBy.mockResolvedValue([
        { clinicId: CLINIC_FULL, _count: { _all: 3 } },
      ]);

      const res = await harness.get(PATH).set('Authorization', `Bearer ${adminToken}`);
      const row = res.body[0];

      expect(Object.keys(row).sort()).toEqual([
        'clinic',
        'compliance',
        'counts',
        'lastActivity',
        'subscription',
      ]);
      expect(typeof row.counts.totalAppointments).toBe('number');
      expect(harness.prisma.appointment.findMany).not.toHaveBeenCalled();
    });
  });

  // ── Backwards compatibility of the sibling endpoint ────────────────────────

  describe('GET /admin/users/clinics (unchanged contract)', () => {
    it('still returns the clinic list fields the dashboard depends on', async () => {
      harness.prisma.clinic.findMany.mockResolvedValue(clinicRows());
      const res = await harness
        .get('/admin/users/clinics')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body[0]).sort()).toEqual([
        'createdAt',
        'email',
        'id',
        'isActive',
        'name',
      ]);
    });

    it('excludes soft-deleted clinics', async () => {
      harness.prisma.clinic.findMany.mockResolvedValue([]);
      await harness.get('/admin/users/clinics').set('Authorization', `Bearer ${adminToken}`);
      expect(harness.prisma.clinic.findMany.mock.calls[0][0].where).toEqual({
        deletedAt: null,
      });
    });
  });
});
