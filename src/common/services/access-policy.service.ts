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
          'Usuários da plataforma ou públicos não podem pertencer a uma clínica',
        );
      }
      return;
    }

    if (!user.clinicId) {
      throw new ForbiddenException(
        'Usuários da clínica devem estar vinculados a uma clínica',
      );
    }
  }

  assertPlatformAdmin(user: AuthUser): void {
    this.assertValidRoleTenantShape(user);

    if (user.role !== 'ADMIN') {
      throw new ForbiddenException('Acesso de administrador da plataforma obrigatório');
    }
  }

  assertClinicMember(user: AuthUser): string {
    this.assertValidRoleTenantShape(user);

    if (!user.clinicId || !this.includesRole(CLINIC_MEMBER_ROLES, user.role)) {
      throw new ForbiddenException('Vínculo com clínica obrigatório');
    }

    return user.clinicId;
  }

  assertClinicAccess(user: AuthUser, clinicId: string): void {
    this.assertValidRoleTenantShape(user);

    if (user.role === 'ADMIN') {
      return;
    }

    if (!user.clinicId || user.clinicId !== clinicId) {
      throw new ForbiddenException('Acesso à clínica negado');
    }
  }

  assertOwnerAccess(user: AuthUser): string {
    this.assertValidRoleTenantShape(user);

    if (!user.clinicId || !this.includesRole(OWNER_LEVEL_ROLES, user.role)) {
      throw new ForbiddenException('Acesso de proprietário da clínica obrigatório');
    }

    return user.clinicId;
  }

  assertClinicOperationsAccess(user: AuthUser): string {
    this.assertValidRoleTenantShape(user);

    if (
      !user.clinicId ||
      !this.includesRole(CLINIC_OPERATIONS_ROLES, user.role)
    ) {
      throw new ForbiddenException('Acesso operacional da clínica obrigatório');
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
        'Profissionais podem acessar apenas o próprio perfil',
      );
    }
  }

  private includesRole(roles: readonly UserRole[], role: UserRole): boolean {
    return roles.includes(role);
  }
}
