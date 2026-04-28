import { ForbiddenException, Injectable } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthUser } from '../types/auth-user.type';

const CLINIC_MEMBER_ROLES: readonly UserRole[] = [
  'OWNER',
  'DENTIST',
  'ASSISTANT',
];
const CLINIC_OPERATIONS_ROLES: readonly UserRole[] = [
  'OWNER',
  'DENTIST',
  'ASSISTANT',
];
const OWNER_LEVEL_ROLES: readonly UserRole[] = ['OWNER'];

@Injectable()
export class AccessPolicyService {
  assertValidRoleTenantShape(user: AuthUser): void {
    if (user.role === 'ADMIN' || user.role === 'PATIENT') {
      if (user.clinicId !== null) {
        throw new ForbiddenException(
          'Platform/public users cannot belong to a clinic tenant',
        );
      }
      return;
    }

    if (!user.clinicId) {
      throw new ForbiddenException(
        'Clinic users must belong to a clinic tenant',
      );
    }
  }

  assertPlatformAdmin(user: AuthUser): void {
    this.assertValidRoleTenantShape(user);

    if (user.role !== 'ADMIN') {
      throw new ForbiddenException('Platform administrator access required');
    }
  }

  assertClinicMember(user: AuthUser): string {
    this.assertValidRoleTenantShape(user);

    if (!user.clinicId || !this.includesRole(CLINIC_MEMBER_ROLES, user.role)) {
      throw new ForbiddenException('Clinic membership required');
    }

    return user.clinicId;
  }

  assertClinicAccess(user: AuthUser, clinicId: string): void {
    this.assertValidRoleTenantShape(user);

    if (user.role === 'ADMIN') {
      return;
    }

    if (!user.clinicId || user.clinicId !== clinicId) {
      throw new ForbiddenException('Clinic access denied');
    }
  }

  assertOwnerAccess(user: AuthUser): string {
    this.assertValidRoleTenantShape(user);

    if (!user.clinicId || !this.includesRole(OWNER_LEVEL_ROLES, user.role)) {
      throw new ForbiddenException('Clinic owner access required');
    }

    return user.clinicId;
  }

  assertClinicOperationsAccess(user: AuthUser): string {
    this.assertValidRoleTenantShape(user);

    if (
      !user.clinicId ||
      !this.includesRole(CLINIC_OPERATIONS_ROLES, user.role)
    ) {
      throw new ForbiddenException('Clinic operations access required');
    }

    return user.clinicId;
  }

  assertDentistProfileAccess(
    user: AuthUser,
    profileUserId: string | null,
  ): void {
    this.assertValidRoleTenantShape(user);

    if (user.role !== 'DENTIST') {
      return;
    }

    if (!profileUserId || profileUserId !== user.id) {
      throw new ForbiddenException(
        'Dentists can only access their own profile',
      );
    }
  }

  private includesRole(roles: readonly UserRole[], role: UserRole): boolean {
    return roles.includes(role);
  }
}
