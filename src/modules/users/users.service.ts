import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { PlanCapabilitiesService } from '../billing/plan-capabilities.service';
import { AdminCreateUserDto } from './dto/admin-create-user.dto';
import { AdminUpdateUserDto } from './dto/admin-update-user.dto';
import { CreateMemberDto } from './dto/create-member.dto';
import { UpdatePasswordDto } from './dto/update-password.dto';
import { UpdateUserDto } from './dto/update-user.dto';

const BCRYPT_ROUNDS = 12;

const USER_SAFE_SELECT = {
  id: true,
  clinicId: true,
  clinic: { select: { id: true, name: true } },
  email: true,
  firstName: true,
  lastName: true,
  role: true,
  phone: true,
  avatarUrl: true,
  isEmailVerified: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const MEMBER_LIST_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  role: true,
  phone: true,
  isActive: true,
  createdAt: true,
} as const;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly planCapabilities: PlanCapabilitiesService,
  ) {}

  // ─── Current user ────────────────────────────────────────────────────────────

  findById(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      select: USER_SAFE_SELECT,
    });
  }

  // ─── OWNER: clinic member management ─────────────────────────────────────────

  async findClinicMembers(clinicId: string) {
    const [users, profiles, usage] = await Promise.all([
      this.prisma.user.findMany({
        where: {
          clinicId,
          role: { in: ['DENTIST', 'ASSISTANT'] },
          deletedAt: null,
        },
        select: MEMBER_LIST_SELECT,
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.profile.findMany({
        where: { clinicId, userId: { not: null } },
        select: {
          id: true,
          userId: true,
          slug: true,
          displayName: true,
          isPublished: true,
        },
      }),
      this.planCapabilities.getUserLimitUsage(clinicId),
    ]);

    const profileByUserId = new Map(profiles.map((p) => [p.userId!, p]));

    const members = users.map((user) => ({
      ...user,
      profile: profileByUserId.get(user.id) ?? null,
    }));

    return { members, usage };
  }

  async createMember(clinicId: string, dto: CreateMemberDto) {
    await this.planCapabilities.assertUserLimitAvailable(clinicId);

    const existing = await this.prisma.user.findFirst({
      where: { email: dto.email },
      select: { id: true },
    });
    if (existing) throw new ConflictException('Este e-mail já está em uso');

    if (dto.role === 'DENTIST') {
      const profileDisplayName =
        dto.displayName?.trim() || `${dto.firstName} ${dto.lastName}`.trim();
      const profileSlug = dto.slug || generateSlug(profileDisplayName);

      const slugTaken = await this.prisma.profile.findUnique({
        where: { slug: profileSlug },
        select: { id: true },
      });
      if (slugTaken) {
        throw new ConflictException(`Slug "${profileSlug}" is already taken`);
      }

      if (dto.specialtyIds && dto.specialtyIds.length > 0) {
        const found = await this.prisma.specialty.findMany({
          where: { id: { in: dto.specialtyIds } },
          select: { id: true },
        });
        if (found.length !== dto.specialtyIds.length) {
          throw new BadRequestException(
            'Uma ou mais especialidades são inválidas',
          );
        }
      }
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    const profileDisplayName =
      dto.displayName?.trim() || `${dto.firstName} ${dto.lastName}`.trim();
    const profileSlug = dto.slug || generateSlug(profileDisplayName);

    const { userId, profileId } = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          clinicId,
          email: dto.email,
          passwordHash,
          firstName: dto.firstName,
          lastName: dto.lastName,
          role: dto.role,
          phone: dto.phone,
        },
        select: { id: true },
      });

      if (dto.role !== 'DENTIST') {
        return { userId: user.id, profileId: null };
      }

      const profile = await tx.profile.create({
        data: {
          clinicId,
          userId: user.id,
          displayName: profileDisplayName,
          slug: profileSlug,
          crmNumber: dto.crmNumber,
          crmState: dto.crmState,
        },
        select: { id: true },
      });

      if (dto.specialtyIds && dto.specialtyIds.length > 0) {
        await tx.profileSpecialty.createMany({
          data: dto.specialtyIds.map((specialtyId) => ({
            profileId: profile.id,
            specialtyId,
          })),
          skipDuplicates: true,
        });
      }

      return { userId: user.id, profileId: profile.id };
    });

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: MEMBER_LIST_SELECT,
    });
    const profile = profileId
      ? await this.prisma.profile.findUnique({
          where: { id: profileId },
          include: {
            profileSpecialties: { include: { specialty: true } },
            services: { orderBy: { displayOrder: 'asc' } },
          },
        })
      : null;

    return { user, profile };
  }

  async updateMember(clinicId: string, userId: string, dto: UpdateUserDto) {
    const member = await this.assertClinicMembership(clinicId, userId);

    if (dto.email) {
      const conflict = await this.prisma.user.findFirst({
        where: { email: dto.email, NOT: { id: userId } },
        select: { id: true },
      });
      if (conflict) throw new ConflictException('Este e-mail já está em uso');
    }

    // Check limit only when reactivating an inactive member
    if (dto.isActive === true && !member.isActive) {
      await this.planCapabilities.assertUserLimitAvailable(clinicId);
    }

    const requiresInvalidation =
      dto.isActive === false || dto.role !== undefined;

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          ...(dto.firstName !== undefined && { firstName: dto.firstName }),
          ...(dto.lastName !== undefined && { lastName: dto.lastName }),
          ...(dto.email !== undefined && { email: dto.email }),
          ...(dto.phone !== undefined && { phone: dto.phone }),
          ...(dto.role !== undefined && { role: dto.role }),
          ...(dto.isActive !== undefined && { isActive: dto.isActive }),
          ...(requiresInvalidation && { tokenVersion: { increment: 1 } }),
        },
      });

      if (requiresInvalidation) {
        await tx.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
    });

    return this.findClinicMemberById(clinicId, userId);
  }

  async deleteMember(clinicId: string, userId: string) {
    await this.assertClinicMembership(clinicId, userId);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { deletedAt: new Date(), isActive: false },
      });

      // Revoke all active refresh tokens so the user is immediately logged out
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      // Unpublish any linked dentist profile so it no longer appears publicly
      await tx.profile.updateMany({
        where: { userId, isPublished: true },
        data: { isPublished: false },
      });
    });
  }

  async updateMemberPassword(
    clinicId: string,
    userId: string,
    dto: UpdatePasswordDto,
  ) {
    await this.assertClinicMembership(clinicId, userId);
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash, tokenVersion: { increment: 1 } },
      });

      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  }

  // ─── ADMIN: global user management ───────────────────────────────────────────

  async adminListClinics() {
    return this.prisma.clinic.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, email: true, isActive: true, createdAt: true },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Platform-wide clinic health summary for the ADMIN dashboard.
   *
   * Uses grouped/batched queries (one query per metric across all clinics)
   * instead of per-clinic Promise.all fan-out, so the query count stays
   * constant regardless of how many clinics exist.
   */
  async adminGetClinicsHealth() {
    const clinics = await this.prisma.clinic.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, email: true, isActive: true, createdAt: true },
      orderBy: { name: 'asc' },
    });

    if (clinics.length === 0) return [];

    const clinicIds = clinics.map((c) => c.id);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [
      subscriptions,
      dentistCounts,
      activeUserCounts,
      totalAppointmentCounts,
      recentAppointmentCounts,
      lastLoginByClinic,
      lastAuditByClinic,
      fiscalProfiles,
    ] = await Promise.all([
      this.prisma.subscription.findMany({
        where: { clinicId: { in: clinicIds } },
        include: { plan: { select: { name: true, slug: true } } },
      }),
      this.prisma.profile.groupBy({
        by: ['clinicId'],
        where: { clinicId: { in: clinicIds } },
        _count: { _all: true },
      }),
      this.prisma.user.groupBy({
        by: ['clinicId'],
        where: { clinicId: { in: clinicIds }, isActive: true, deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.appointment.groupBy({
        by: ['clinicId'],
        where: { clinicId: { in: clinicIds } },
        _count: { _all: true },
      }),
      this.prisma.appointment.groupBy({
        by: ['clinicId'],
        where: { clinicId: { in: clinicIds }, appointmentDate: { gte: thirtyDaysAgo } },
        _count: { _all: true },
      }),
      this.prisma.user.groupBy({
        by: ['clinicId'],
        where: { clinicId: { in: clinicIds }, deletedAt: null },
        _max: { lastLoginAt: true },
      }),
      this.prisma.auditLog.groupBy({
        by: ['clinicId'],
        where: { clinicId: { in: clinicIds } },
        _max: { createdAt: true },
      }),
      this.prisma.clinicFiscalProfile.findMany({
        where: { clinicId: { in: clinicIds } },
        select: { clinicId: true, isConfigured: true },
      }),
    ]);

    const subscriptionByClinic = new Map(subscriptions.map((s) => [s.clinicId, s]));
    const dentistCountByClinic = new Map(
      dentistCounts.map((row) => [row.clinicId, row._count._all]),
    );
    const activeUserCountByClinic = new Map(
      activeUserCounts.map((row) => [row.clinicId, row._count._all]),
    );
    const totalAppointmentCountByClinic = new Map(
      totalAppointmentCounts.map((row) => [row.clinicId, row._count._all]),
    );
    const recentAppointmentCountByClinic = new Map(
      recentAppointmentCounts.map((row) => [row.clinicId, row._count._all]),
    );
    const lastLoginMap = new Map(
      lastLoginByClinic.map((row) => [row.clinicId, row._max.lastLoginAt]),
    );
    const lastAuditMap = new Map(
      lastAuditByClinic.map((row) => [row.clinicId, row._max.createdAt]),
    );
    const fiscalProfileByClinic = new Map(fiscalProfiles.map((f) => [f.clinicId, f]));

    return clinics.map((clinic) => {
      const subscription = subscriptionByClinic.get(clinic.id) ?? null;
      const lastLoginAt = lastLoginMap.get(clinic.id) ?? null;
      const lastAuditAt = lastAuditMap.get(clinic.id) ?? null;

      let lastActivity: { timestamp: Date | null; source: 'USER_LOGIN' | 'AUDIT_LOG' | null };
      if (lastLoginAt && (!lastAuditAt || lastLoginAt >= lastAuditAt)) {
        lastActivity = { timestamp: lastLoginAt, source: 'USER_LOGIN' };
      } else if (lastAuditAt) {
        lastActivity = { timestamp: lastAuditAt, source: 'AUDIT_LOG' };
      } else {
        lastActivity = { timestamp: null, source: null };
      }

      const fiscalProfile = fiscalProfileByClinic.get(clinic.id) ?? null;

      return {
        clinic: {
          id: clinic.id,
          name: clinic.name,
          email: clinic.email,
          createdAt: clinic.createdAt,
          isActive: clinic.isActive,
        },
        subscription: subscription
          ? {
              planSlug: subscription.plan?.slug ?? null,
              planName: subscription.plan?.name ?? null,
              status: subscription.status,
              trialEndsAt: subscription.trialEndsAt,
              billingInterval: subscription.billingInterval,
              createdAt: subscription.createdAt,
            }
          : null,
        counts: {
          dentists: dentistCountByClinic.get(clinic.id) ?? 0,
          activeUsers: activeUserCountByClinic.get(clinic.id) ?? 0,
          totalAppointments: totalAppointmentCountByClinic.get(clinic.id) ?? 0,
          recentAppointments: recentAppointmentCountByClinic.get(clinic.id) ?? 0,
        },
        lastActivity,
        compliance: {
          fiscalSetupComplete: fiscalProfile ? fiscalProfile.isConfigured : null,
        },
      };
    });
  }

  async adminFindAll(page = 1, limit = 20) {
    const take = Math.min(limit, 100);
    const skip = (page - 1) * take;

    const total = await this.prisma.user.count({ where: { deletedAt: null } });
    const users = await this.prisma.user.findMany({
      where: { deletedAt: null },
      select: USER_SAFE_SELECT,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    });

    return { data: users, total, page, limit: take };
  }

  async adminFindById(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: USER_SAFE_SELECT,
    });
    if (!user) throw new NotFoundException('Usuário não encontrado');
    return user;
  }

  async adminCreate(dto: AdminCreateUserDto) {
    const clinicMemberRoles = ['OWNER', 'DENTIST', 'ASSISTANT'];
    if (clinicMemberRoles.includes(dto.role) && !dto.clinicId) {
      throw new BadRequestException(
        `clinicId is required for role ${dto.role}`,
      );
    }

    if ((dto.role === 'ADMIN' || dto.role === 'PATIENT') && dto.clinicId) {
      throw new BadRequestException(
        `clinicId deve ser omitido para o papel ${dto.role}`,
      );
    }

    if (dto.clinicId) {
      const clinic = await this.prisma.clinic.findFirst({
        where: { id: dto.clinicId, deletedAt: null },
        select: { id: true },
      });
      if (!clinic) throw new NotFoundException('Clínica não encontrada');
    }

    const existing = await this.prisma.user.findFirst({
      where: { email: dto.email },
      select: { id: true },
    });
    if (existing) throw new ConflictException('Este e-mail já está em uso');

    // New clinic members count against the plan limit (new users are active by default)
    if (dto.clinicId && clinicMemberRoles.includes(dto.role)) {
      await this.planCapabilities.assertUserLimitAvailable(dto.clinicId);
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    return this.prisma.user.create({
      data: {
        clinicId: dto.clinicId ?? null,
        email: dto.email,
        passwordHash,
        firstName: dto.firstName,
        lastName: dto.lastName,
        role: dto.role,
        phone: dto.phone,
      },
      select: USER_SAFE_SELECT,
    });
  }

  async adminUpdate(userId: string, dto: AdminUpdateUserDto) {
    const current = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, role: true, clinicId: true, isActive: true },
    });
    if (!current) throw new NotFoundException('Usuário não encontrado');

    // Resolve the effective role and clinicId after the update
    const effectiveRole = dto.role ?? current.role;
    const effectiveClinicId =
      dto.clinicId !== undefined ? dto.clinicId : current.clinicId;
    const effectiveIsActive =
      dto.isActive !== undefined ? dto.isActive : current.isActive;

    const clinicMemberRoles = ['OWNER', 'DENTIST', 'ASSISTANT'];
    if (clinicMemberRoles.includes(effectiveRole) && !effectiveClinicId) {
      throw new BadRequestException(
        `clinicId é obrigatório para o papel ${effectiveRole}`,
      );
    }
    if (
      (effectiveRole === 'ADMIN' || effectiveRole === 'PATIENT') &&
      effectiveClinicId
    ) {
      throw new BadRequestException(
        `clinicId deve ser omitido para o papel ${effectiveRole}`,
      );
    }

    if (dto.email) {
      const conflict = await this.prisma.user.findFirst({
        where: { email: dto.email, NOT: { id: userId } },
        select: { id: true },
      });
      if (conflict) throw new ConflictException('Este e-mail já está em uso');
    }

    if (effectiveClinicId) {
      const clinic = await this.prisma.clinic.findFirst({
        where: { id: effectiveClinicId, deletedAt: null },
        select: { id: true },
      });
      if (!clinic) throw new NotFoundException('Clínica não encontrada');
    }

    // Enforce limit when the update would add a net new active clinic member
    if (clinicMemberRoles.includes(effectiveRole) && effectiveIsActive) {
      const currentlyCountsForThisClinic =
        current.isActive &&
        current.clinicId === effectiveClinicId &&
        clinicMemberRoles.includes(current.role);

      if (!currentlyCountsForThisClinic) {
        await this.planCapabilities.assertUserLimitAvailable(effectiveClinicId!);
      }
    }

    const requiresInvalidation =
      dto.isActive === false ||
      dto.role !== undefined ||
      dto.clinicId !== undefined;

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.user.update({
        where: { id: userId },
        data: {
          ...(dto.firstName !== undefined && { firstName: dto.firstName }),
          ...(dto.lastName !== undefined && { lastName: dto.lastName }),
          ...(dto.email !== undefined && { email: dto.email }),
          ...(dto.phone !== undefined && { phone: dto.phone }),
          ...(dto.role !== undefined && { role: dto.role }),
          ...(dto.isActive !== undefined && { isActive: dto.isActive }),
          ...(dto.clinicId !== undefined && { clinicId: dto.clinicId }),
          ...(requiresInvalidation && { tokenVersion: { increment: 1 } }),
        },
        select: USER_SAFE_SELECT,
      });

      if (requiresInvalidation) {
        await tx.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }

      return result;
    });

    return updated;
  }

  async adminDelete(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('Usuário não encontrado');

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { deletedAt: new Date(), isActive: false },
      });

      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  }

  async adminUpdatePassword(userId: string, dto: UpdatePasswordDto) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('Usuário não encontrado');

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash, tokenVersion: { increment: 1 } },
      });

      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private async assertClinicMembership(clinicId: string, userId: string) {
    const member = await this.prisma.user.findFirst({
      where: {
        id: userId,
        clinicId,
        role: { in: ['DENTIST', 'ASSISTANT'] },
        deletedAt: null,
      },
      select: { id: true, isActive: true },
    });
    if (!member) throw new NotFoundException('Usuário não encontrado');
    return member;
  }

  private async findClinicMemberById(clinicId: string, userId: string) {
    const member = await this.prisma.user.findFirst({
      where: {
        id: userId,
        clinicId,
        role: { in: ['DENTIST', 'ASSISTANT'] },
        deletedAt: null,
      },
      select: MEMBER_LIST_SELECT,
    });
    const profile = await this.prisma.profile.findFirst({
      where: { clinicId, userId },
      select: {
        id: true,
        userId: true,
        slug: true,
        displayName: true,
        isPublished: true,
      },
    });

    if (!member) throw new NotFoundException('Usuário não encontrado');

    return {
      ...member,
      profile,
    };
  }
}

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
