import { patientIdentityFilter } from '../../src/common/utils/patient-identity';

/** Service unit tests model legacy-only rows; real resolution is covered separately. */
export function createPatientResolverMock() {
  return {
    requirePatient: jest.fn().mockResolvedValue({ id: 'patient-1' }),
    resolveLegacyIdentifier: jest.fn().mockResolvedValue(null),
    resolveReference: jest
      .fn()
      .mockImplementation(
        (_clinic: string, _identifier: string, patientId?: string) =>
          Promise.resolve(patientId ? { id: patientId } : null),
      ),
    scopeWhere: jest
      .fn()
      .mockImplementation(
        (_clinic: string, identifier: string, patientId?: string) =>
          Promise.resolve(
            patientId
              ? { patientId }
              : { patientId: null, ...patientIdentityFilter(identifier) },
          ),
      ),
    createPatient: jest.fn().mockResolvedValue({ id: 'patient-new' }),
  };
}
