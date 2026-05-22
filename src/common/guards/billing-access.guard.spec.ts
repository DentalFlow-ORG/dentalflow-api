import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { REQUIRES_BILLING_ACCESS_KEY } from '../decorators/requires-billing-access.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PaymentRequiredException } from '../exceptions/payment-required.exception';
import type { AuthUser } from '../types/auth-user.type';
import { BillingAccessGuard } from './billing-access.guard';

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

function billingReflector(): Reflector {
  return makeReflector({
    [IS_PUBLIC_KEY]: undefined,
    [REQUIRES_BILLING_ACCESS_KEY]: true,
  });
}

const ownerUser: AuthUser = { id: 'u1', clinicId: 'clinic-1', role: 'OWNER' };
const adminUser: AuthUser = { id: 'u4', clinicId: null, role: 'ADMIN' };

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('BillingAccessGuard', () => {
  let billingSvcMock: { getCurrentSubscriptionStatus: jest.Mock };

  beforeEach(() => {
    billingSvcMock = {
      getCurrentSubscriptionStatus: jest.fn(),
    };
  });

  describe('opt-in behavior', () => {
    it('returns true for @Public() routes', async () => {
      const guard = new BillingAccessGuard(
        makeReflector({ [IS_PUBLIC_KEY]: true }),
        billingSvcMock as never,
      );

      await expect(guard.canActivate(makeContext(ownerUser))).resolves.toBe(true);
    });

    it('returns true for routes without @RequiresBillingAccess() (guard is opt-in)', async () => {
      const guard = new BillingAccessGuard(
        makeReflector({ [IS_PUBLIC_KEY]: undefined, [REQUIRES_BILLING_ACCESS_KEY]: undefined }),
        billingSvcMock as never,
      );

      await expect(guard.canActivate(makeContext(ownerUser))).resolves.toBe(true);
      expect(billingSvcMock.getCurrentSubscriptionStatus).not.toHaveBeenCalled();
    });
  });

  describe('ADMIN bypass', () => {
    it('returns true for ADMIN without checking billing status', async () => {
      const guard = new BillingAccessGuard(billingReflector(), billingSvcMock as never);

      await expect(guard.canActivate(makeContext(adminUser))).resolves.toBe(true);
      expect(billingSvcMock.getCurrentSubscriptionStatus).not.toHaveBeenCalled();
    });
  });

  describe('clinic membership requirement', () => {
    it('throws ForbiddenException for a user without clinicId', async () => {
      const guard = new BillingAccessGuard(billingReflector(), billingSvcMock as never);
      const context = makeContext({ id: 'u5', clinicId: null, role: 'PATIENT' });

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
      expect(billingSvcMock.getCurrentSubscriptionStatus).not.toHaveBeenCalled();
    });
  });

  describe('active / trialing subscription', () => {
    it('returns true when accessAllowed is true', async () => {
      billingSvcMock.getCurrentSubscriptionStatus.mockResolvedValue({
        accessAllowed: true,
        status: 'active',
      });
      const guard = new BillingAccessGuard(billingReflector(), billingSvcMock as never);

      await expect(guard.canActivate(makeContext(ownerUser))).resolves.toBe(true);
    });

    it('queries billing status using the user clinicId', async () => {
      billingSvcMock.getCurrentSubscriptionStatus.mockResolvedValue({ accessAllowed: true });
      const guard = new BillingAccessGuard(billingReflector(), billingSvcMock as never);

      await guard.canActivate(makeContext(ownerUser));

      expect(billingSvcMock.getCurrentSubscriptionStatus).toHaveBeenCalledWith('clinic-1');
    });
  });

  describe('inactive / missing subscription', () => {
    it('throws PaymentRequiredException (HTTP 402) when accessAllowed is false', async () => {
      billingSvcMock.getCurrentSubscriptionStatus.mockResolvedValue({
        accessAllowed: false,
        status: 'missing',
        requiresPlanSelection: true,
        requiresPayment: false,
        message: 'Nenhuma assinatura encontrada.',
      });
      const guard = new BillingAccessGuard(billingReflector(), billingSvcMock as never);

      await expect(guard.canActivate(makeContext(ownerUser))).rejects.toThrow(
        PaymentRequiredException,
      );
    });

    it('PaymentRequiredException carries HTTP 402 status', async () => {
      billingSvcMock.getCurrentSubscriptionStatus.mockResolvedValue({
        accessAllowed: false,
        status: 'canceled',
        requiresPlanSelection: false,
        requiresPayment: true,
        message: 'Sua assinatura foi cancelada.',
      });
      const guard = new BillingAccessGuard(billingReflector(), billingSvcMock as never);

      try {
        await guard.canActivate(makeContext(ownerUser));
        throw new Error('Expected exception not thrown');
      } catch (err) {
        expect((err as PaymentRequiredException).getStatus()).toBe(402);
      }
    });
  });
});
