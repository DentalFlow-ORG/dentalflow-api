import { createPatientResolverMock } from '../../../test/support/patient-resolver.mock';
import { ConflictException } from '@nestjs/common';
import { ClinicalRecordsService } from './clinical-records.service';

/**
 * Patient identity is derived from denormalized name/email columns, so a
 * name-only identifier can cover two different people. These tests pin the
 * containment guard: clinical reads and writes must refuse an ambiguous
 * identifier instead of merging or overwriting one patient's data with
 * another's. Failing loudly is recoverable; silent cross-patient attribution
 * is not.
 */

const CLINIC = 'clinic-1';
const OWNER_USER = 'owner-1';
const AMBIGUOUS = 'Maria Silva';

function createPrisma() {
  return {
    clinicalRecord: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue({ id: 'record-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    odontogramRecord: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
  };
}

function createService(ambiguous: boolean) {
  const prisma = createPrisma();
  const patientIdentity = {
    isAmbiguousIdentity: jest.fn().mockResolvedValue(ambiguous),
    assertUnambiguousIdentity: jest.fn(() =>
      ambiguous
        ? Promise.reject(new ConflictException('ambiguous'))
        : Promise.resolve(),
    ),
  };
  return {
    prisma,
    patientIdentity,
    service: new ClinicalRecordsService(
      prisma as never,
      patientIdentity as never,
      createPatientResolverMock() as never,
    ),
  };
}

describe('ClinicalRecordsService — ambiguous patient identity', () => {
  describe('when one name covers more than one patient', () => {
    it('refuses to return the clinical record timeline', async () => {
      const { service, prisma } = createService(true);

      await expect(
        service.getPatientTimeline(CLINIC, OWNER_USER, 'OWNER', AMBIGUOUS),
      ).rejects.toBeInstanceOf(ConflictException);

      // The guard must run before the query, not filter its results.
      expect(prisma.clinicalRecord.findMany).not.toHaveBeenCalled();
    });

    it('refuses to return an odontogram', async () => {
      const { service, prisma } = createService(true);

      await expect(
        service.getOdontogram(CLINIC, OWNER_USER, 'OWNER', AMBIGUOUS),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.odontogramRecord.findFirst).not.toHaveBeenCalled();
    });

    it('refuses to write an odontogram instead of overwriting another patient’s chart', async () => {
      // The destructive case: upsert finds a chart by name and updates it, so
      // charting one patient would silently replace the other's dental record.
      const { service, prisma } = createService(true);

      await expect(
        service.upsertOdontogram(
          CLINIC,
          OWNER_USER,
          'OWNER',
          AMBIGUOUS,
          AMBIGUOUS,
          {} as never,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.odontogramRecord.update).not.toHaveBeenCalled();
      expect(prisma.odontogramRecord.create).not.toHaveBeenCalled();
    });
  });

  describe('when the identifier resolves to a single patient', () => {
    it('reads the timeline normally', async () => {
      const { service, prisma } = createService(false);

      await service.getPatientTimeline(CLINIC, OWNER_USER, 'OWNER', AMBIGUOUS);

      expect(prisma.clinicalRecord.findMany).toHaveBeenCalled();
    });

    it('writes the odontogram normally', async () => {
      const { service, prisma } = createService(false);

      await service.upsertOdontogram(
        CLINIC,
        OWNER_USER,
        'OWNER',
        AMBIGUOUS,
        AMBIGUOUS,
        {} as never,
      );

      expect(prisma.odontogramRecord.create).toHaveBeenCalled();
    });

    it('checks identity on every guarded clinical entry point', async () => {
      const { service, patientIdentity } = createService(false);

      await service.getPatientTimeline(CLINIC, OWNER_USER, 'OWNER', AMBIGUOUS);
      await service.getOdontogram(CLINIC, OWNER_USER, 'OWNER', AMBIGUOUS);
      await service.upsertOdontogram(
        CLINIC,
        OWNER_USER,
        'OWNER',
        AMBIGUOUS,
        AMBIGUOUS,
        {} as never,
      );

      expect(patientIdentity.assertUnambiguousIdentity).toHaveBeenCalledTimes(
        3,
      );
      expect(patientIdentity.assertUnambiguousIdentity).toHaveBeenCalledWith(
        CLINIC,
        AMBIGUOUS,
      );
    });
  });
});
