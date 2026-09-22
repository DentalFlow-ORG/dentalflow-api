import { createPatientResolverMock } from '../../../test/support/patient-resolver.mock';
import 'reflect-metadata';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ClinicalRecordStatus } from '@prisma/client';

import { REQUIRES_PLAN_FEATURE_KEY } from '../../common/decorators/require-plan-feature.decorator';
import { PlanFeature } from '../billing/plan-feature.types';
import { ClinicalDictationService } from './clinical-dictation.service';
import type { DictationResult } from './clinical-dictation.service';
import { ClinicalRecordsController } from './clinical-records.controller';
import { ClinicalRecordsService } from './clinical-records.service';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const CLINIC_ID = 'clinic-1';
const USER_ID = 'user-1';
const RECORD_ID = 'record-1';

const mockAccessPolicy = {
  assertClinicOperationsAccess: jest.fn().mockReturnValue(CLINIC_ID),
};

const mockClinicalRecordsService = {
  validateRecordForDictation: jest.fn(),
} as unknown as jest.Mocked<
  Pick<ClinicalRecordsService, 'validateRecordForDictation'>
>;

const mockClinicalDictationService = {
  dictate: jest.fn(),
} as unknown as jest.Mocked<Pick<ClinicalDictationService, 'dictate'>>;

const SAMPLE_RESULT: DictationResult = {
  transcript: 'Paciente relata dor no dente 36.',
  fields: {
    chiefComplaint: 'Dor no dente 36',
    clinicalEvolution: 'Sensibilidade ao frio.',
  },
  odontogramSuggestions: [],
};

const VALID_DTO = {
  audioBase64: 'UklGRiQAAABXQVZFZm10IBAAAAABAAEA',
  mimeType: 'audio/webm' as const,
};

function buildUser(role: 'OWNER' | 'DENTIST' = 'DENTIST') {
  return { id: USER_ID, clinicId: CLINIC_ID, role };
}

function buildController(): ClinicalRecordsController {
  return new ClinicalRecordsController(
    mockClinicalRecordsService as never,
    mockClinicalDictationService as never,
    mockAccessPolicy as never,
  );
}

// ── Controller-level tests ────────────────────────────────────────────────────

describe('ClinicalRecordsController — POST :id/dictate', () => {
  let controller: ClinicalRecordsController;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClinicalRecordsService.validateRecordForDictation = jest
      .fn()
      .mockResolvedValue(undefined);
    mockClinicalDictationService.dictate = jest
      .fn()
      .mockResolvedValue(SAMPLE_RESULT);
    controller = buildController();
  });

  // ── 1. Happy path ───────────────────────────────────────────────────────────

  it('validates the record then calls dictation service and returns its result', async () => {
    const user = buildUser('OWNER');

    const result = await controller.dictate(user, RECORD_ID, VALID_DTO);

    expect(mockAccessPolicy.assertClinicOperationsAccess).toHaveBeenCalledWith(
      user,
    );
    expect(
      mockClinicalRecordsService.validateRecordForDictation,
    ).toHaveBeenCalledWith(CLINIC_ID, USER_ID, 'OWNER', RECORD_ID);
    expect(mockClinicalDictationService.dictate).toHaveBeenCalledWith(
      CLINIC_ID,
      USER_ID,
      VALID_DTO,
    );
    expect(result).toEqual(SAMPLE_RESULT);
  });

  // ── 2. Record validation failure — dictation service NOT called ─────────────

  it('does not call ClinicalDictationService when validation throws', async () => {
    mockClinicalRecordsService.validateRecordForDictation = jest
      .fn()
      .mockRejectedValue(
        new ForbiddenException(
          'Este prontuário não pode ser editado no status atual.',
        ),
      );

    await expect(
      controller.dictate(buildUser(), RECORD_ID, VALID_DTO),
    ).rejects.toThrow(ForbiddenException);

    expect(mockClinicalDictationService.dictate).not.toHaveBeenCalled();
  });

  // ── 3. Wrong dentist — dictation service NOT called ─────────────────────────

  it('does not call ClinicalDictationService when dentist access is denied', async () => {
    mockClinicalRecordsService.validateRecordForDictation = jest
      .fn()
      .mockRejectedValue(
        new ForbiddenException(
          'Profissionais podem acessar apenas os próprios prontuários',
        ),
      );

    await expect(
      controller.dictate(buildUser('DENTIST'), RECORD_ID, VALID_DTO),
    ).rejects.toThrow(ForbiddenException);

    expect(mockClinicalDictationService.dictate).not.toHaveBeenCalled();
  });

  // ── 4. @RequirePlanFeature(CLINICAL_DICTATION) metadata ────────────────────

  it('has @RequirePlanFeature(CLINICAL_DICTATION) on the dictate handler', () => {
    const feature = Reflect.getMetadata(
      REQUIRES_PLAN_FEATURE_KEY,
      ClinicalRecordsController.prototype.dictate,
    );
    expect(feature).toBe(PlanFeature.CLINICAL_DICTATION);
  });
});

// ── Service-level tests for validateRecordForDictation ────────────────────────

describe('ClinicalRecordsService.validateRecordForDictation', () => {
  const mockPrisma = {
    clinicalRecord: { findFirst: jest.fn() },
  };

  function buildService() {
    // Dynamically import to avoid circular issues; use direct instantiation.
    /* eslint-disable @typescript-eslint/no-require-imports -- loaded per call, after the mocks are in place */
    const { ClinicalRecordsService: Svc } =
      require('./clinical-records.service') as {
        ClinicalRecordsService: typeof ClinicalRecordsService;
      };
    /* eslint-enable @typescript-eslint/no-require-imports */
    return new Svc(
      mockPrisma as never,
      {
        assertUnambiguousIdentity: jest.fn().mockResolvedValue(undefined),
        isAmbiguousIdentity: jest.fn().mockResolvedValue(false),
      } as never,
      createPatientResolverMock() as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const baseRecord = {
    id: RECORD_ID,
    clinicId: CLINIC_ID,
    status: 'DRAFT' as ClinicalRecordStatus,
    profile: { userId: USER_ID },
  };

  // ── 5. Record not in clinic ─────────────────────────────────────────────────

  it('throws NotFoundException when the record does not exist in the clinic', async () => {
    mockPrisma.clinicalRecord.findFirst.mockResolvedValue(null);
    const service = buildService();

    await expect(
      service.validateRecordForDictation(
        CLINIC_ID,
        USER_ID,
        'OWNER',
        RECORD_ID,
      ),
    ).rejects.toThrow(NotFoundException);
  });

  // ── 6. Non-DRAFT record ─────────────────────────────────────────────────────

  it('throws ForbiddenException when the record is not in DRAFT status', async () => {
    mockPrisma.clinicalRecord.findFirst.mockResolvedValue({
      ...baseRecord,
      status: 'COMPLETED' as ClinicalRecordStatus,
    });
    const service = buildService();

    await expect(
      service.validateRecordForDictation(
        CLINIC_ID,
        USER_ID,
        'DENTIST',
        RECORD_ID,
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  // ── 7. DRAFT record — resolves without throwing ─────────────────────────────

  it('resolves without error for a DRAFT record owned by the requesting DENTIST', async () => {
    mockPrisma.clinicalRecord.findFirst.mockResolvedValue(baseRecord);
    const service = buildService();

    await expect(
      service.validateRecordForDictation(
        CLINIC_ID,
        USER_ID,
        'DENTIST',
        RECORD_ID,
      ),
    ).resolves.toBeUndefined();
  });
});
