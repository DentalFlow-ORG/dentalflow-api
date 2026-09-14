import { NotFoundException } from '@nestjs/common';

import { UsersService } from './users.service';

const CLINIC_ID = 'clinic-1';
const USER_ID = 'user-1';

const txMock = {
  user: { update: jest.fn() },
  refreshToken: { updateMany: jest.fn() },
  profile: { updateMany: jest.fn() },
};

const mockPrisma = {
  user: { findFirst: jest.fn(), groupBy: jest.fn() },
  clinic: { findMany: jest.fn() },
  subscription: { findMany: jest.fn() },
  profile: { groupBy: jest.fn() },
  appointment: { groupBy: jest.fn() },
  auditLog: { groupBy: jest.fn() },
  clinicFiscalProfile: { findMany: jest.fn() },
  $transaction: jest.fn((callback: (tx: typeof txMock) => unknown) =>
    callback(txMock),
  ),
};

function member(overrides: { clinicId?: string; role?: string } = {}) {
  return {
    id: USER_ID,
    clinicId: overrides.clinicId ?? CLINIC_ID,
    role: overrides.role ?? 'DENTIST',
    isActive: true,
    deletedAt: null,
  };
}

describe('UsersService.deleteMember', () => {
  let service: UsersService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new UsersService(mockPrisma as never, {} as never);
  });

  it('soft-deletes the user (sets deletedAt and isActive: false)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(member());

    await service.deleteMember(CLINIC_ID, USER_ID);

    expect(txMock.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: expect.objectContaining({ isActive: false }),
    });
    const call = txMock.user.update.mock.calls[0][0] as {
      data: { deletedAt: unknown };
    };
    expect(call.data.deletedAt).toBeInstanceOf(Date);
  });

  it('revokes all active refresh tokens', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(member());

    await service.deleteMember(CLINIC_ID, USER_ID);

    expect(txMock.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('unpublishes linked dentist profile via profile.updateMany', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(member());

    await service.deleteMember(CLINIC_ID, USER_ID);

    expect(txMock.profile.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, isPublished: true },
      data: { isPublished: false },
    });
  });

  it('throws NotFoundException when userId belongs to a different clinic', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null);

    await expect(service.deleteMember(CLINIC_ID, USER_ID)).rejects.toThrow(
      NotFoundException,
    );
    expect(txMock.user.update).not.toHaveBeenCalled();
  });

  it('throws NotFoundException for OWNER role (role filter in assertClinicMembership)', async () => {
    // assertClinicMembership filters role: { in: ['DENTIST', 'ASSISTANT'] }
    // so OWNER users are invisible to it → returns null → NotFoundException
    mockPrisma.user.findFirst.mockResolvedValue(null);

    await expect(service.deleteMember(CLINIC_ID, USER_ID)).rejects.toThrow(
      NotFoundException,
    );
  });
});

// ── adminListClinics ─────────────────────────────────────────────────────────

describe('UsersService.adminListClinics', () => {
  let service: UsersService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new UsersService(mockPrisma as never, {} as never);
  });

  it('selects id, name, email, isActive, and createdAt for non-deleted clinics', async () => {
    mockPrisma.clinic.findMany.mockResolvedValue([]);

    await service.adminListClinics();

    expect(mockPrisma.clinic.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null },
      select: {
        id: true,
        name: true,
        email: true,
        isActive: true,
        createdAt: true,
      },
      orderBy: { name: 'asc' },
    });
  });

  it('returns the clinics from prisma unchanged', async () => {
    const clinics = [
      {
        id: 'clinic-1',
        name: 'Clínica A',
        email: 'a@clinic.com',
        isActive: true,
        createdAt: new Date('2026-01-01'),
      },
    ];
    mockPrisma.clinic.findMany.mockResolvedValue(clinics);

    const result = await service.adminListClinics();

    expect(result).toEqual(clinics);
  });
});

// ── adminGetClinicsHealth ─────────────────────────────────────────────────────

describe('UsersService.adminGetClinicsHealth', () => {
  let service: UsersService;

  const CLINIC_A = 'clinic-a';
  const CLINIC_B = 'clinic-b';

  function baseClinics() {
    return [
      {
        id: CLINIC_A,
        name: 'Clínica A',
        email: 'a@clinic.com',
        isActive: true,
        createdAt: new Date('2026-01-01'),
      },
      {
        id: CLINIC_B,
        name: 'Clínica B',
        email: 'b@clinic.com',
        isActive: true,
        createdAt: new Date('2026-02-01'),
      },
    ];
  }

  function mockEmptyAggregates() {
    mockPrisma.subscription.findMany.mockResolvedValue([]);
    mockPrisma.profile.groupBy.mockResolvedValue([]);
    mockPrisma.appointment.groupBy.mockResolvedValue([]);
    mockPrisma.auditLog.groupBy.mockResolvedValue([]);
    mockPrisma.clinicFiscalProfile.findMany.mockResolvedValue([]);
    // user.groupBy is called twice (active users, then last login) — both default empty
    mockPrisma.user.groupBy.mockResolvedValue([]);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    service = new UsersService(mockPrisma as never, {} as never);
  });

  it('returns one row per non-deleted clinic', async () => {
    mockPrisma.clinic.findMany.mockResolvedValue(baseClinics());
    mockEmptyAggregates();

    const result = await service.adminGetClinicsHealth();

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.clinic.id)).toEqual([CLINIC_A, CLINIC_B]);
    expect(mockPrisma.clinic.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null } }),
    );
  });

  it('returns an empty array without querying aggregates when there are no clinics', async () => {
    mockPrisma.clinic.findMany.mockResolvedValue([]);

    const result = await service.adminGetClinicsHealth();

    expect(result).toEqual([]);
    expect(mockPrisma.subscription.findMany).not.toHaveBeenCalled();
  });

  it('returns zero counts (not errors) for a clinic with no dentists/appointments', async () => {
    mockPrisma.clinic.findMany.mockResolvedValue([baseClinics()[0]]);
    mockEmptyAggregates();

    const [row] = await service.adminGetClinicsHealth();

    expect(row.counts).toEqual({
      dentists: 0,
      activeUsers: 0,
      totalAppointments: 0,
      recentAppointments: 0,
    });
  });

  it('returns subscription: null when the clinic has no subscription', async () => {
    mockPrisma.clinic.findMany.mockResolvedValue([baseClinics()[0]]);
    mockEmptyAggregates();

    const [row] = await service.adminGetClinicsHealth();

    expect(row.subscription).toBeNull();
  });

  it('returns lastActivity: { timestamp: null, source: null } when there is no login or audit data', async () => {
    mockPrisma.clinic.findMany.mockResolvedValue([baseClinics()[0]]);
    mockEmptyAggregates();

    const [row] = await service.adminGetClinicsHealth();

    expect(row.lastActivity).toEqual({ timestamp: null, source: null });
  });

  it('returns fiscalSetupComplete: null when the clinic has no fiscal profile', async () => {
    mockPrisma.clinic.findMany.mockResolvedValue([baseClinics()[0]]);
    mockEmptyAggregates();

    const [row] = await service.adminGetClinicsHealth();

    expect(row.compliance).toEqual({ fiscalSetupComplete: null });
  });

  it('scopes dentist, active user, and appointment counts per clinic without leaking across clinics', async () => {
    mockPrisma.clinic.findMany.mockResolvedValue(baseClinics());
    mockPrisma.subscription.findMany.mockResolvedValue([]);
    mockPrisma.profile.groupBy.mockResolvedValue([
      { clinicId: CLINIC_A, _count: { _all: 3 } },
      { clinicId: CLINIC_B, _count: { _all: 1 } },
    ]);
    // user.groupBy call #1 = active users, call #2 = last login max
    mockPrisma.user.groupBy
      .mockResolvedValueOnce([
        { clinicId: CLINIC_A, _count: { _all: 5 } },
        { clinicId: CLINIC_B, _count: { _all: 2 } },
      ])
      .mockResolvedValueOnce([]);
    // appointment.groupBy call #1 = total, call #2 = recent 30 days
    mockPrisma.appointment.groupBy
      .mockResolvedValueOnce([
        { clinicId: CLINIC_A, _count: { _all: 40 } },
        { clinicId: CLINIC_B, _count: { _all: 10 } },
      ])
      .mockResolvedValueOnce([{ clinicId: CLINIC_A, _count: { _all: 6 } }]);
    mockPrisma.auditLog.groupBy.mockResolvedValue([]);
    mockPrisma.clinicFiscalProfile.findMany.mockResolvedValue([]);

    const result = await service.adminGetClinicsHealth();
    const rowA = result.find((r) => r.clinic.id === CLINIC_A)!;
    const rowB = result.find((r) => r.clinic.id === CLINIC_B)!;

    expect(rowA.counts).toEqual({
      dentists: 3,
      activeUsers: 5,
      totalAppointments: 40,
      recentAppointments: 6,
    });
    expect(rowB.counts).toEqual({
      dentists: 1,
      activeUsers: 2,
      totalAppointments: 10,
      recentAppointments: 0,
    });
  });

  it('excludes deleted clinics from the result', async () => {
    // deletedAt: null is enforced in the where clause passed to prisma —
    // this test asserts the query itself, since the mock can't filter for us.
    mockPrisma.clinic.findMany.mockResolvedValue(baseClinics());
    mockEmptyAggregates();

    await service.adminGetClinicsHealth();

    expect(mockPrisma.clinic.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null } }),
    );
  });

  it('prefers the most recent of lastLoginAt vs. audit log activity, tagging the source', async () => {
    mockPrisma.clinic.findMany.mockResolvedValue([baseClinics()[0]]);
    mockPrisma.subscription.findMany.mockResolvedValue([]);
    mockPrisma.profile.groupBy.mockResolvedValue([]);
    mockPrisma.appointment.groupBy.mockResolvedValue([]);
    mockPrisma.user.groupBy
      .mockResolvedValueOnce([]) // active users
      .mockResolvedValueOnce([
        { clinicId: CLINIC_A, _max: { lastLoginAt: new Date('2026-06-01') } },
      ]); // last login
    mockPrisma.auditLog.groupBy.mockResolvedValue([
      { clinicId: CLINIC_A, _max: { createdAt: new Date('2026-06-15') } },
    ]);
    mockPrisma.clinicFiscalProfile.findMany.mockResolvedValue([]);

    const [row] = await service.adminGetClinicsHealth();

    // audit log activity (June 15) is more recent than the login (June 1)
    expect(row.lastActivity).toEqual({
      timestamp: new Date('2026-06-15'),
      source: 'AUDIT_LOG',
    });
  });

  it('returns fiscalSetupComplete: true when the fiscal profile is configured', async () => {
    mockPrisma.clinic.findMany.mockResolvedValue([baseClinics()[0]]);
    mockPrisma.subscription.findMany.mockResolvedValue([]);
    mockPrisma.profile.groupBy.mockResolvedValue([]);
    mockPrisma.user.groupBy.mockResolvedValue([]);
    mockPrisma.appointment.groupBy.mockResolvedValue([]);
    mockPrisma.auditLog.groupBy.mockResolvedValue([]);
    mockPrisma.clinicFiscalProfile.findMany.mockResolvedValue([
      { clinicId: CLINIC_A, isConfigured: true },
    ]);

    const [row] = await service.adminGetClinicsHealth();

    expect(row.compliance).toEqual({ fiscalSetupComplete: true });
  });

  it('includes subscription and plan data when a subscription exists', async () => {
    mockPrisma.clinic.findMany.mockResolvedValue([baseClinics()[0]]);
    mockPrisma.subscription.findMany.mockResolvedValue([
      {
        clinicId: CLINIC_A,
        status: 'TRIALING',
        trialEndsAt: new Date('2026-07-01'),
        billingInterval: 'MONTHLY',
        createdAt: new Date('2026-06-01'),
        plan: { name: 'Profissional', slug: 'professional' },
      },
    ]);
    mockPrisma.profile.groupBy.mockResolvedValue([]);
    mockPrisma.user.groupBy.mockResolvedValue([]);
    mockPrisma.appointment.groupBy.mockResolvedValue([]);
    mockPrisma.auditLog.groupBy.mockResolvedValue([]);
    mockPrisma.clinicFiscalProfile.findMany.mockResolvedValue([]);

    const [row] = await service.adminGetClinicsHealth();

    expect(row.subscription).toEqual({
      planSlug: 'professional',
      planName: 'Profissional',
      status: 'TRIALING',
      trialEndsAt: new Date('2026-07-01'),
      billingInterval: 'MONTHLY',
      createdAt: new Date('2026-06-01'),
    });
  });
});
