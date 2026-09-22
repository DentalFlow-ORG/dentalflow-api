import { createPatientResolverMock } from '../../../test/support/patient-resolver.mock';
import { PatientsService } from './patients.service';

// ── Prisma mock ───────────────────────────────────────────────────────────────

const prismaMock = {
  // Avatars are matched on LOWER(TRIM(identifier)) so rows written before
  // patient-identity normalization stay reachable, which needs raw SQL.
  $queryRaw: jest.fn(),
};

/** Bound parameters of the raw avatar query: [clinicId, ...identity keys]. */
function queryValues(call = 0): unknown[] {
  return (prismaMock.$queryRaw.mock.calls[call][0] as { values: unknown[] })
    .values;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const CLINIC_ID = 'clinic-abc';

function createService() {
  return new PatientsService(
    prismaMock as any,
    createPatientResolverMock() as never,
  );
}

// ── batchGetPatientAvatars ────────────────────────────────────────────────────

describe('PatientsService.batchGetPatientAvatars', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns an avatar map for multiple identifiers', async () => {
    prismaMock.$queryRaw.mockResolvedValue([
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
    prismaMock.$queryRaw.mockResolvedValue([
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
    prismaMock.$queryRaw.mockResolvedValue([]);

    await createService().batchGetPatientAvatars(CLINIC_ID, [
      'dup@test.com',
      'dup@test.com',
      'dup@test.com',
    ]);

    // clinicId plus exactly one identity key — the duplicates collapsed.
    expect(queryValues()).toEqual([CLINIC_ID, 'dup@test.com']);
  });

  it('trims leading/trailing whitespace from identifiers', async () => {
    prismaMock.$queryRaw.mockResolvedValue([]);

    await createService().batchGetPatientAvatars(CLINIC_ID, [
      '  spaced@test.com  ',
    ]);

    expect(queryValues()).toContain('spaced@test.com');
    expect(queryValues()).not.toContain('  spaced@test.com  ');
  });

  it('scopes the query to the provided clinicId (tenant isolation)', async () => {
    prismaMock.$queryRaw.mockResolvedValue([]);

    await createService().batchGetPatientAvatars('clinic-other', [
      'x@test.com',
    ]);

    expect(queryValues()[0]).toBe('clinic-other');
  });

  it('returns an empty avatars map and skips the DB call when identifiers is empty', async () => {
    const result = await createService().batchGetPatientAvatars(CLINIC_ID, []);

    expect(result.avatars).toEqual({});
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it('returns an empty avatars map and skips DB when all identifiers are blank after trim', async () => {
    const result = await createService().batchGetPatientAvatars(CLINIC_ID, [
      '  ',
      '   ',
    ]);

    expect(result.avatars).toEqual({});
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it('handles a row with avatarUrl: null gracefully', async () => {
    prismaMock.$queryRaw.mockResolvedValue([
      { identifier: 'noimg@test.com', avatarUrl: null },
    ]);

    const result = await createService().batchGetPatientAvatars(CLINIC_ID, [
      'noimg@test.com',
    ]);

    expect(result.avatars['noimg@test.com']).toBeNull();
  });
});
