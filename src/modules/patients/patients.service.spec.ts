import { PatientsService } from './patients.service';

// ── Prisma mock ───────────────────────────────────────────────────────────────

const prismaMock = {
  patientAvatar: {
    findMany: jest.fn(),
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const CLINIC_ID = 'clinic-abc';

function createService() {
  return new PatientsService(prismaMock as any);
}

// ── batchGetPatientAvatars ────────────────────────────────────────────────────

describe('PatientsService.batchGetPatientAvatars', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns an avatar map for multiple identifiers', async () => {
    prismaMock.patientAvatar.findMany.mockResolvedValue([
      { identifier: 'a@test.com', avatarUrl: 'base64a' },
      { identifier: 'b@test.com', avatarUrl: 'base64b' },
    ]);

    const result = await createService().batchGetPatientAvatars(CLINIC_ID, [
      'a@test.com',
      'b@test.com',
    ]);

    expect(result.avatars).toEqual({
      'a@test.com': 'base64a',
      'b@test.com': 'base64b',
    });
  });

  it('returns null for identifiers that have no saved avatar', async () => {
    prismaMock.patientAvatar.findMany.mockResolvedValue([
      { identifier: 'a@test.com', avatarUrl: 'base64a' },
    ]);

    const result = await createService().batchGetPatientAvatars(CLINIC_ID, [
      'a@test.com',
      'missing@test.com',
    ]);

    expect(result.avatars['a@test.com']).toBe('base64a');
    expect(result.avatars['missing@test.com']).toBeNull();
  });

  it('deduplicates identifiers before querying so each is sent once', async () => {
    prismaMock.patientAvatar.findMany.mockResolvedValue([]);

    await createService().batchGetPatientAvatars(CLINIC_ID, [
      'dup@test.com',
      'dup@test.com',
      'dup@test.com',
    ]);

    const { where } = prismaMock.patientAvatar.findMany.mock.calls[0][0] as {
      where: { identifier: { in: string[] }; clinicId: string };
    };
    expect(where.identifier.in).toHaveLength(1);
    expect(where.identifier.in).toEqual(['dup@test.com']);
  });

  it('trims leading/trailing whitespace from identifiers', async () => {
    prismaMock.patientAvatar.findMany.mockResolvedValue([]);

    await createService().batchGetPatientAvatars(CLINIC_ID, ['  spaced@test.com  ']);

    const { where } = prismaMock.patientAvatar.findMany.mock.calls[0][0] as {
      where: { identifier: { in: string[] }; clinicId: string };
    };
    expect(where.identifier.in).toContain('spaced@test.com');
    expect(where.identifier.in).not.toContain('  spaced@test.com  ');
  });

  it('scopes the query to the provided clinicId (tenant isolation)', async () => {
    prismaMock.patientAvatar.findMany.mockResolvedValue([]);

    await createService().batchGetPatientAvatars('clinic-other', ['x@test.com']);

    const { where } = prismaMock.patientAvatar.findMany.mock.calls[0][0] as {
      where: { clinicId: string; identifier: { in: string[] } };
    };
    expect(where.clinicId).toBe('clinic-other');
  });

  it('returns an empty avatars map and skips the DB call when identifiers is empty', async () => {
    const result = await createService().batchGetPatientAvatars(CLINIC_ID, []);

    expect(result.avatars).toEqual({});
    expect(prismaMock.patientAvatar.findMany).not.toHaveBeenCalled();
  });

  it('returns an empty avatars map and skips DB when all identifiers are blank after trim', async () => {
    const result = await createService().batchGetPatientAvatars(CLINIC_ID, ['  ', '   ']);

    expect(result.avatars).toEqual({});
    expect(prismaMock.patientAvatar.findMany).not.toHaveBeenCalled();
  });

  it('handles a row with avatarUrl: null gracefully', async () => {
    prismaMock.patientAvatar.findMany.mockResolvedValue([
      { identifier: 'noimg@test.com', avatarUrl: null },
    ]);

    const result = await createService().batchGetPatientAvatars(CLINIC_ID, ['noimg@test.com']);

    expect(result.avatars['noimg@test.com']).toBeNull();
  });
});
