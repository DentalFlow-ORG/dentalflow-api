import { ForbiddenException } from '@nestjs/common';

import type { AuthUser } from '../types/auth-user.type';
import { AccessPolicyService } from './access-policy.service';

describe('AccessPolicyService', () => {
  let service: AccessPolicyService;

  beforeEach(() => {
    service = new AccessPolicyService();
  });

  function owner(clinicId = 'clinic-1'): AuthUser {
    return { id: 'u1', clinicId, role: 'OWNER' };
  }

  function dentist(clinicId = 'clinic-1'): AuthUser {
    return { id: 'u2', clinicId, role: 'DENTIST' };
  }

  function assistant(clinicId = 'clinic-1'): AuthUser {
    return { id: 'u3', clinicId, role: 'ASSISTANT' };
  }

  function admin(): AuthUser {
    return { id: 'u4', clinicId: null, role: 'ADMIN' };
  }

  function patient(): AuthUser {
    return { id: 'u5', clinicId: null, role: 'PATIENT' };
  }

  // ── assertValidRoleTenantShape ────────────────────────────────────────────

  describe('assertValidRoleTenantShape', () => {
    it('passes for ADMIN with null clinicId', () => {
      expect(() => service.assertValidRoleTenantShape(admin())).not.toThrow();
    });

    it('passes for PATIENT with null clinicId', () => {
      expect(() => service.assertValidRoleTenantShape(patient())).not.toThrow();
    });

    it('throws ForbiddenException for ADMIN with a non-null clinicId', () => {
      expect(() =>
        service.assertValidRoleTenantShape({ id: 'u4', clinicId: 'clinic-x', role: 'ADMIN' }),
      ).toThrow(ForbiddenException);
    });

    it('throws ForbiddenException for PATIENT with a non-null clinicId', () => {
      expect(() =>
        service.assertValidRoleTenantShape({ id: 'u5', clinicId: 'clinic-x', role: 'PATIENT' }),
      ).toThrow(ForbiddenException);
    });

    it.each(['OWNER', 'DENTIST', 'ASSISTANT'] as const)(
      'passes for %s with a clinicId',
      (role) => {
        expect(() =>
          service.assertValidRoleTenantShape({ id: 'u1', clinicId: 'clinic-1', role }),
        ).not.toThrow();
      },
    );

    it.each(['OWNER', 'DENTIST', 'ASSISTANT'] as const)(
      'throws ForbiddenException for %s without clinicId',
      (role) => {
        expect(() =>
          service.assertValidRoleTenantShape({ id: 'u1', clinicId: null, role }),
        ).toThrow(ForbiddenException);
      },
    );
  });

  // ── assertPlatformAdmin ───────────────────────────────────────────────────

  describe('assertPlatformAdmin', () => {
    it('passes for ADMIN', () => {
      expect(() => service.assertPlatformAdmin(admin())).not.toThrow();
    });

    it.each(['OWNER', 'DENTIST', 'ASSISTANT'] as const)(
      'throws ForbiddenException for %s',
      (role) => {
        expect(() =>
          service.assertPlatformAdmin({ id: 'u1', clinicId: 'clinic-1', role }),
        ).toThrow(ForbiddenException);
      },
    );
  });

  // ── assertClinicMember ────────────────────────────────────────────────────

  describe('assertClinicMember', () => {
    it.each(['OWNER', 'DENTIST', 'ASSISTANT'] as const)(
      'returns clinicId for %s with a clinicId',
      (role) => {
        const result = service.assertClinicMember({ id: 'u1', clinicId: 'clinic-1', role });
        expect(result).toBe('clinic-1');
      },
    );

    it('throws ForbiddenException for ADMIN (no clinicId)', () => {
      expect(() => service.assertClinicMember(admin())).toThrow(ForbiddenException);
    });

    it('throws ForbiddenException for PATIENT (no clinicId)', () => {
      expect(() => service.assertClinicMember(patient())).toThrow(ForbiddenException);
    });
  });

  // ── assertClinicAccess ────────────────────────────────────────────────────

  describe('assertClinicAccess', () => {
    it('passes for ADMIN regardless of which clinicId is checked', () => {
      expect(() => service.assertClinicAccess(admin(), 'any-clinic')).not.toThrow();
    });

    it('passes for OWNER when clinicIds match', () => {
      expect(() => service.assertClinicAccess(owner('clinic-1'), 'clinic-1')).not.toThrow();
    });

    it('throws ForbiddenException for OWNER when clinicId does not match', () => {
      expect(() =>
        service.assertClinicAccess(owner('clinic-1'), 'clinic-2'),
      ).toThrow(ForbiddenException);
    });

    it('throws ForbiddenException when user clinicId is null', () => {
      expect(() =>
        service.assertClinicAccess({ id: 'u1', clinicId: null, role: 'OWNER' }, 'clinic-1'),
      ).toThrow(ForbiddenException);
    });
  });

  // ── assertOwnerAccess ─────────────────────────────────────────────────────

  describe('assertOwnerAccess', () => {
    it('returns clinicId for OWNER', () => {
      expect(service.assertOwnerAccess(owner('clinic-1'))).toBe('clinic-1');
    });

    it('throws ForbiddenException for DENTIST', () => {
      expect(() => service.assertOwnerAccess(dentist())).toThrow(ForbiddenException);
    });

    it('throws ForbiddenException for ASSISTANT', () => {
      expect(() => service.assertOwnerAccess(assistant())).toThrow(ForbiddenException);
    });
  });

  // ── assertClinicOperationsAccess ──────────────────────────────────────────

  describe('assertClinicOperationsAccess', () => {
    it.each(['OWNER', 'DENTIST', 'ASSISTANT'] as const)(
      'returns clinicId for %s',
      (role) => {
        const result = service.assertClinicOperationsAccess({
          id: 'u1',
          clinicId: 'clinic-1',
          role,
        });
        expect(result).toBe('clinic-1');
      },
    );

    it('throws ForbiddenException for PATIENT (no clinicId)', () => {
      expect(() => service.assertClinicOperationsAccess(patient())).toThrow(ForbiddenException);
    });

    it('throws ForbiddenException for ADMIN (no clinicId)', () => {
      expect(() => service.assertClinicOperationsAccess(admin())).toThrow(ForbiddenException);
    });
  });

  // ── assertOwnerOrAssistantAccess ──────────────────────────────────────────

  describe('assertOwnerOrAssistantAccess', () => {
    it('returns clinicId for OWNER', () => {
      expect(service.assertOwnerOrAssistantAccess(owner())).toBe('clinic-1');
    });

    it('returns clinicId for ASSISTANT', () => {
      expect(service.assertOwnerOrAssistantAccess(assistant())).toBe('clinic-1');
    });

    it('throws ForbiddenException for DENTIST', () => {
      expect(() => service.assertOwnerOrAssistantAccess(dentist())).toThrow(ForbiddenException);
    });
  });

  // ── assertDentistProfileAccess ────────────────────────────────────────────

  describe('assertDentistProfileAccess', () => {
    it('passes for OWNER regardless of profileUserId', () => {
      expect(() =>
        service.assertDentistProfileAccess(owner(), 'some-other-id'),
      ).not.toThrow();
    });

    it('passes for ADMIN regardless of profileUserId', () => {
      expect(() =>
        service.assertDentistProfileAccess(admin(), 'some-other-id'),
      ).not.toThrow();
    });

    it('passes for DENTIST accessing their own profile', () => {
      const d = dentist();
      expect(() => service.assertDentistProfileAccess(d, d.id)).not.toThrow();
    });

    it('throws ForbiddenException for DENTIST accessing a different profile', () => {
      expect(() =>
        service.assertDentistProfileAccess(dentist(), 'different-user-id'),
      ).toThrow(ForbiddenException);
    });

    it('throws ForbiddenException for DENTIST when profileUserId is null', () => {
      expect(() =>
        service.assertDentistProfileAccess(dentist(), null),
      ).toThrow(ForbiddenException);
    });
  });
});
