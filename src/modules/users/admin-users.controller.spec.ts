import { ForbiddenException } from '@nestjs/common';

import { AccessPolicyService } from '../../common/services/access-policy.service';
import type { AuthUser } from '../../common/types/auth-user.type';
import { AdminUsersController } from './admin-users.controller';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockUsersService = {
  adminGetClinicsHealth: jest.fn(),
  adminListClinics: jest.fn(),
  adminUpdate: jest.fn(),
  adminDelete: jest.fn(),
};

function user(
  role: AuthUser['role'],
  clinicId: string | null = 'clinic-1',
): AuthUser {
  return { id: 'user-1', clinicId, role };
}

// Uses the real AccessPolicyService (no constructor deps) so authorization
// tests exercise the actual assertPlatformAdmin logic, not a mocked stand-in.
const accessPolicy = new AccessPolicyService();

describe('AdminUsersController.getClinicsHealth', () => {
  let controller: AdminUsersController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new AdminUsersController(
      mockUsersService as never,
      accessPolicy,
    );
  });

  it('allows ADMIN and returns the health rows', () => {
    const healthRows = [{ clinic: { id: 'clinic-1', name: 'Clínica A' } }];
    mockUsersService.adminGetClinicsHealth.mockReturnValue(healthRows);

    const result = controller.getClinicsHealth(user('ADMIN', null));

    expect(result).toBe(healthRows);
    expect(mockUsersService.adminGetClinicsHealth).toHaveBeenCalledWith();
  });

  it.each(['OWNER', 'DENTIST', 'ASSISTANT'] as const)(
    'throws ForbiddenException for %s and does not call the service',
    (role) => {
      expect(() => controller.getClinicsHealth(user(role))).toThrow(
        ForbiddenException,
      );
      expect(mockUsersService.adminGetClinicsHealth).not.toHaveBeenCalled();
    },
  );

  it('throws ForbiddenException for PATIENT', () => {
    expect(() => controller.getClinicsHealth(user('PATIENT', null))).toThrow(
      ForbiddenException,
    );
    expect(mockUsersService.adminGetClinicsHealth).not.toHaveBeenCalled();
  });
});

// The self-lockout guard lives in UsersService and is proven there; this only
// pins the wiring: the actor passed to the service must be the authenticated
// admin, never the edited user, or the guard would silently compare the wrong
// ids.
describe('AdminUsersController self-lockout wiring', () => {
  let controller: AdminUsersController;
  const admin: AuthUser = { id: 'admin-7', clinicId: null, role: 'ADMIN' };

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new AdminUsersController(
      mockUsersService as never,
      accessPolicy,
    );
  });

  it('forwards the authenticated admin id as the actor on update', async () => {
    const dto = { role: 'ASSISTANT' } as never;

    await controller.update(admin, 'user-42', dto);

    expect(mockUsersService.adminUpdate).toHaveBeenCalledWith(
      'user-42',
      dto,
      'admin-7',
    );
  });

  it('forwards the authenticated admin id as the actor on delete', async () => {
    await controller.remove(admin, 'user-42');

    expect(mockUsersService.adminDelete).toHaveBeenCalledWith(
      'user-42',
      'admin-7',
    );
  });

  it('refuses a non-admin before reaching the service', () => {
    expect(() =>
      controller.update(user('OWNER'), 'user-42', {} as never),
    ).toThrow(ForbiddenException);
    expect(mockUsersService.adminUpdate).not.toHaveBeenCalled();
  });
});

// Note: unauthenticated request rejection is enforced by the global JwtAuthGuard
// (see src/common/guards/jwt-auth.guard.spec.ts) before this controller is ever
// reached, so it is not re-tested at the controller/handler level here.
