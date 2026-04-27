import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateMemberDto } from './dto/create-member.dto';

const BCRYPT_ROUNDS = 12;

const USER_SAFE_SELECT = {
  id: true,
  clinicId: true,
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
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      select: USER_SAFE_SELECT,
    });
  }

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
