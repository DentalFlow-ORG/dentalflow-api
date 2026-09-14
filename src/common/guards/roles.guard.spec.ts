import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { IS_ANY_AUTHENTICATED_KEY } from '../decorators/any-authenticated.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { AuthUser } from '../types/auth-user.type';
import { RolesGuard } from './roles.guard';

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

function ownerUser(): AuthUser {
  return { id: 'u1', clinicId: 'clinic-1', role: 'OWNER' };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('RolesGuard', () => {
  describe('@Public() shortcut', () => {
    it('returns true without inspecting user or roles', () => {
      const guard = new RolesGuard(makeReflector({ [IS_PUBLIC_KEY]: true }));

      expect(guard.canActivate(makeContext())).toBe(true);
    });
  });

  describe('deny-by-default: no access policy declared', () => {
    it('throws ForbiddenException when neither @Roles() nor @AnyAuthenticated() is present', () => {
      const guard = new RolesGuard(
        makeReflector({
          [IS_PUBLIC_KEY]: undefined,
          [ROLES_KEY]: undefined,
          [IS_ANY_AUTHENTICATED_KEY]: undefined,
        }),
      );

      expect(() => guard.canActivate(makeContext(ownerUser()))).toThrow(
        new ForbiddenException('No access policy declared on this route'),
      );
    });
  });

  describe('@AnyAuthenticated()', () => {
    it('returns true for any authenticated user when @AnyAuthenticated() is present', () => {
      const guard = new RolesGuard(
        makeReflector({
          [IS_PUBLIC_KEY]: undefined,
          [ROLES_KEY]: undefined,
          [IS_ANY_AUTHENTICATED_KEY]: true,
        }),
      );

      expect(guard.canActivate(makeContext(ownerUser()))).toBe(true);
    });
  });

  describe('@Roles() enforcement', () => {
    it('returns true when user role is in the required roles list', () => {
      const guard = new RolesGuard(
        makeReflector({
          [IS_PUBLIC_KEY]: undefined,
          [ROLES_KEY]: ['OWNER', 'DENTIST'],
        }),
      );

      expect(guard.canActivate(makeContext(ownerUser()))).toBe(true);
    });

    it('returns true when user is DENTIST and DENTIST is in required roles', () => {
      const guard = new RolesGuard(
        makeReflector({
          [IS_PUBLIC_KEY]: undefined,
          [ROLES_KEY]: ['OWNER', 'DENTIST'],
        }),
      );
      const context = makeContext({
        id: 'u2',
        clinicId: 'clinic-1',
        role: 'DENTIST',
      });

      expect(guard.canActivate(context)).toBe(true);
    });

    it('throws ForbiddenException when user role is not in the required roles list', () => {
      const guard = new RolesGuard(
        makeReflector({ [IS_PUBLIC_KEY]: undefined, [ROLES_KEY]: ['OWNER'] }),
      );
      const context = makeContext({
        id: 'u2',
        clinicId: 'clinic-1',
        role: 'DENTIST',
      });

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('has no ADMIN bypass — ADMIN is rejected when not listed in @Roles()', () => {
      // ADMIN is a platform role; it gets no implicit superuser access to clinic routes.
      // Routes accessible to ADMIN must explicitly declare @Roles('ADMIN').
      const guard = new RolesGuard(
        makeReflector({ [IS_PUBLIC_KEY]: undefined, [ROLES_KEY]: ['OWNER'] }),
      );
      const context = makeContext({ id: 'u4', clinicId: null, role: 'ADMIN' });

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('passes ADMIN when ADMIN is explicitly listed in @Roles()', () => {
      const guard = new RolesGuard(
        makeReflector({ [IS_PUBLIC_KEY]: undefined, [ROLES_KEY]: ['ADMIN'] }),
      );
      const context = makeContext({ id: 'u4', clinicId: null, role: 'ADMIN' });

      expect(guard.canActivate(context)).toBe(true);
    });
  });
});
