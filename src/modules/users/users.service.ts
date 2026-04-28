import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
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

// Maps plan slug → max users allowed. NULL plan or unknown slug → DEFAULT.
const PLAN_USER_LIMITS: Record<string, number> = {
  basic: 8,
  pro: 16,
  enterprise: 24,
};
const DEFAULT_USER_LIMIT = 8;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Current user ────────────────────────────────────────────────────────────

  findById(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      select: USER_SAFE_SELECT,
    });
  }

  // ─── OWNER: clinic member management ─────────────────────────────────────────

  async findClinicMembers(clinicId: string) {
    const [users, profiles] = await Promise.all([
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
    ]);

    const profileByUserId = new Map(profiles.map((p) => [p.userId!, p]));

    return users.map((user) => ({
      ...user,
      profile: profileByUserId.get(user.id) ?? null,
    }));
  }

  async createMember(clinicId: string, dto: CreateMemberDto) {
    await this.checkPlanUserLimit(clinicId);

    const existing = await this.prisma.user.findFirst({
      where: { email: dto.email },
      select: { id: true },
    });
    if (existing) throw new ConflictException('Email already in use');

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
          throw new BadRequestException('One or more specialty IDs are invalid');
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

    const [user, profile] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: MEMBER_LIST_SELECT,
      }),
      profileId
        ? this.prisma.profile.findUnique({
            where: { id: profileId },
            include: {
              profileSpecialties: { include: { specialty: true } },
              services: { orderBy: { displayOrder: 'asc' } },
            },
          })
        : Promise.resolve(null),
    ]);

    return { user, profile };
  }

  async updateMember(clinicId: string, userId: string, dto: UpdateUserDto) {
    await this.assertClinicMembership(clinicId, userId);

    if (dto.email) {
      const conflict = await this.prisma.user.findFirst({
        where: { email: dto.email, NOT: { id: userId } },
        select: { id: true },
      });
      if (conflict) throw new ConflictException('Email already in use');
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.firstName !== undefined && { firstName: dto.firstName }),
        ...(dto.lastName !== undefined && { lastName: dto.lastName }),
        ...(dto.email !== undefined && { email: dto.email }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.role !== undefined && { role: dto.role }),
      },
      select: MEMBER_LIST_SELECT,
    });

    return updated;
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
        data: { passwordHash },
      });

      // Force re-login after a password change
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
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  async adminFindAll(page = 1, limit = 20) {
    const take = Math.min(limit, 100);
    const skip = (page - 1) * take;

    const [total, users] = await Promise.all([
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.user.findMany({
        where: { deletedAt: null },
        select: USER_SAFE_SELECT,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
    ]);

    return { data: users, total, page, limit: take };
  }

  async adminFindById(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: USER_SAFE_SELECT,
    });
    if (!user) throw new NotFoundException('User not found');
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
        `clinicId must be omitted for role ${dto.role}`,
      );
    }

    if (dto.clinicId) {
      const clinic = await this.prisma.clinic.findFirst({
        where: { id: dto.clinicId, deletedAt: null },
        select: { id: true },
      });
      if (!clinic) throw new NotFoundException('Clinic not found');
    }

    const existing = await this.prisma.user.findFirst({
      where: { email: dto.email },
      select: { id: true },
    });
    if (existing) throw new ConflictException('Email already in use');

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
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('User not found');

    if (dto.email) {
      const conflict = await this.prisma.user.findFirst({
        where: { email: dto.email, NOT: { id: userId } },
        select: { id: true },
      });
      if (conflict) throw new ConflictException('Email already in use');
    }

    if (dto.clinicId !== undefined && dto.clinicId !== null) {
      const clinic = await this.prisma.clinic.findFirst({
        where: { id: dto.clinicId, deletedAt: null },
        select: { id: true },
      });
      if (!clinic) throw new NotFoundException('Clinic not found');
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.firstName !== undefined && { firstName: dto.firstName }),
        ...(dto.lastName !== undefined && { lastName: dto.lastName }),
        ...(dto.email !== undefined && { email: dto.email }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.role !== undefined && { role: dto.role }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        ...(dto.clinicId !== undefined && { clinicId: dto.clinicId }),
      },
      select: USER_SAFE_SELECT,
    });

    // Revoke tokens if the account was deactivated
    if (dto.isActive === false) {
      await this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    return updated;
  }

  async adminDelete(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('User not found');

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
    if (!user) throw new NotFoundException('User not found');

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash },
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
      select: { id: true },
    });
    if (!member) throw new NotFoundException('User not found');
    return member;
  }

  private async checkPlanUserLimit(clinicId: string): Promise<void> {
    const [userCount, subscription] = await Promise.all([
      this.prisma.user.count({
        where: { clinicId, deletedAt: null },
      }),
      this.prisma.subscription.findUnique({
        where: { clinicId },
        select: { plan: { select: { slug: true } } },
      }),
    ]);

    const planSlug = subscription?.plan?.slug?.toLowerCase() ?? '';
    const limit = PLAN_USER_LIMITS[planSlug] ?? DEFAULT_USER_LIMIT;

    if (userCount >= limit) {
      throw new ForbiddenException('User limit reached for current plan');
    }
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
