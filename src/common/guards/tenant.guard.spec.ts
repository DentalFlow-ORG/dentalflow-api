import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { TENANT_SCOPED_KEY } from '../decorators/tenant-scoped.decorator';
import { AccessPolicyService } from '../services/access-policy.service';
import type { AuthUser } from '../types/auth-user.type';
import { TenantGuard } from './tenant.guard';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReflector(metadata: Record<string, unknown>): Reflector {
  return {
    getAllAndOverride: jest
      .fn()
      .mockImplementation((key: string) => metadata[key]),
  } as unknown as Reflector;
}

function makeContext(user?: AuthUser): ExecutionContext {
  return {
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('TenantGuard', () => {
  // TenantGuard uses the real AccessPolicyService — it has no external deps of its own.
  let accessPolicy: AccessPolicyService;

  beforeEach(() => {
    accessPolicy = new AccessPolicyService();
  });

  describe('opt-in behavior', () => {
    it('returns true for @Public() routes', () => {
      const guard = new TenantGuard(
        makeReflector({ [IS_PUBLIC_KEY]: true }),
        accessPolicy,
      );

      expect(guard.canActivate(makeContext())).toBe(true);
    });

    it('returns true for routes without @TenantScoped() (guard is opt-in)', () => {
      const guard = new TenantGuard(
        makeReflector({ [IS_PUBLIC_KEY]: undefined, [TENANT_SCOPED_KEY]: undefined }),
        accessPolicy,
      );

      expect(guard.canActivate(makeContext())).toBe(true);
    });
  });

  describe('@TenantScoped() enforcement', () => {
    function tenantScopedReflector(): Reflector {
      return makeReflector({ [IS_PUBLIC_KEY]: undefined, [TENANT_SCOPED_KEY]: true });
    }

    it('returns true for OWNER with a clinicId', () => {
      const guard = new TenantGuard(tenantScopedReflector(), accessPolicy);
      const context = makeContext({ id: 'u1', clinicId: 'clinic-1', role: 'OWNER' });

      expect(guard.canActivate(context)).toBe(true);
    });

    it('returns true for DENTIST with a clinicId', () => {
      const guard = new TenantGuard(tenantScopedReflector(), accessPolicy);
      const context = makeContext({ id: 'u2', clinicId: 'clinic-1', role: 'DENTIST' });

      expect(guard.canActivate(context)).toBe(true);
    });

    it('throws ForbiddenException for a user without clinicId (e.g. ADMIN)', () => {
      // ADMIN has no clinicId and therefore fails assertClinicMember.
      // TenantGuard has no ADMIN bypass — clinic routes are for clinic staff only.
      const guard = new TenantGuard(tenantScopedReflector(), accessPolicy);
      const context = makeContext({ id: 'u4', clinicId: null, role: 'ADMIN' });

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('throws ForbiddenException for PATIENT without clinicId', () => {
      const guard = new TenantGuard(tenantScopedReflector(), accessPolicy);
      const context = makeContext({ id: 'u5', clinicId: null, role: 'PATIENT' });

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });
});
