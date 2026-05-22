import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { REQUIRES_PLAN_FEATURE_KEY } from '../decorators/require-plan-feature.decorator';
import { PlanFeature } from '../../modules/billing/plan-feature.types';
import type { AuthUser } from '../types/auth-user.type';
import { PlanFeatureGuard } from './plan-feature.guard';

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

function featureReflector(feature: PlanFeature): Reflector {
  return makeReflector({
    [IS_PUBLIC_KEY]: undefined,
    [REQUIRES_PLAN_FEATURE_KEY]: feature,
  });
}

const ownerUser: AuthUser = { id: 'u1', clinicId: 'clinic-1', role: 'OWNER' };
const adminUser: AuthUser = { id: 'u4', clinicId: null, role: 'ADMIN' };

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('PlanFeatureGuard', () => {
  let planCapsMock: { assertFeature: jest.Mock };

  beforeEach(() => {
    planCapsMock = { assertFeature: jest.fn().mockResolvedValue(undefined) };
  });

  describe('opt-in behavior', () => {
    it('returns true for @Public() routes', async () => {
      const guard = new PlanFeatureGuard(
        makeReflector({ [IS_PUBLIC_KEY]: true }),
        planCapsMock as never,
      );

      await expect(guard.canActivate(makeContext(ownerUser))).resolves.toBe(true);
    });

    it('returns true for routes without @RequirePlanFeature() (guard is opt-in)', async () => {
      const guard = new PlanFeatureGuard(
        makeReflector({ [IS_PUBLIC_KEY]: undefined, [REQUIRES_PLAN_FEATURE_KEY]: undefined }),
        planCapsMock as never,
      );

      await expect(guard.canActivate(makeContext(ownerUser))).resolves.toBe(true);
      expect(planCapsMock.assertFeature).not.toHaveBeenCalled();
    });
  });

  describe('ADMIN bypass', () => {
    it('returns true for ADMIN without calling assertFeature', async () => {
      const guard = new PlanFeatureGuard(
        featureReflector(PlanFeature.FINANCE),
        planCapsMock as never,
      );

      await expect(guard.canActivate(makeContext(adminUser))).resolves.toBe(true);
      expect(planCapsMock.assertFeature).not.toHaveBeenCalled();
    });
  });

  describe('feature access enforcement', () => {
    it('returns true when assertFeature resolves (feature available in plan)', async () => {
      const guard = new PlanFeatureGuard(
        featureReflector(PlanFeature.FINANCE),
        planCapsMock as never,
      );

      await expect(guard.canActivate(makeContext(ownerUser))).resolves.toBe(true);
    });

    it('calls assertFeature with the correct clinicId and feature', async () => {
      const guard = new PlanFeatureGuard(
        featureReflector(PlanFeature.INVENTORY),
        planCapsMock as never,
      );

      await guard.canActivate(makeContext(ownerUser));

      expect(planCapsMock.assertFeature).toHaveBeenCalledWith('clinic-1', PlanFeature.INVENTORY);
    });

    it('propagates ForbiddenException when assertFeature throws (feature not in plan)', async () => {
      planCapsMock.assertFeature.mockRejectedValue(
        new ForbiddenException(
          'Este recurso não está disponível no seu plano atual. Faça upgrade para continuar.',
        ),
      );
      const guard = new PlanFeatureGuard(
        featureReflector(PlanFeature.REPORTS),
        planCapsMock as never,
      );

      await expect(guard.canActivate(makeContext(ownerUser))).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
