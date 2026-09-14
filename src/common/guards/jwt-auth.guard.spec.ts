import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';

// JwtAuthGuard has exactly one custom behavior: bypassing Passport for @Public() routes.
// The non-public path delegates to AuthGuard('jwt') which runs the full Passport/JWT strategy.
// That path requires the DI container + JwtStrategy + database and is not meaningful to
// unit-test in isolation — it is covered by integration / e2e tests.

function makeContext(): ExecutionContext {
  return {
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: jest.fn(),
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  describe('@Public() bypass', () => {
    it('returns true immediately when the route is marked @Public()', () => {
      const reflector = {
        getAllAndOverride: jest.fn().mockImplementation((key: string) =>
          key === IS_PUBLIC_KEY ? true : undefined,
        ),
      };
      const guard = new JwtAuthGuard(reflector as unknown as Reflector);

      const result = guard.canActivate(makeContext());

      expect(result).toBe(true);
    });

    it('does not invoke the Passport super chain for @Public() routes', () => {
      const reflector = {
        getAllAndOverride: jest.fn().mockReturnValue(true),
      };
      const guard = new JwtAuthGuard(reflector as unknown as Reflector);

      // Spy on the parent prototype canActivate to confirm it is never reached
      const parentProto = Object.getPrototypeOf(JwtAuthGuard.prototype) as {
        canActivate: jest.Mock;
      };
      const superSpy = jest
        .spyOn(parentProto, 'canActivate')
        .mockReturnValue(true);

      void guard.canActivate(makeContext());

      expect(superSpy).not.toHaveBeenCalled();
      superSpy.mockRestore();
    });
  });
});
