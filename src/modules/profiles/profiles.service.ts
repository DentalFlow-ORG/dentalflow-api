import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateProfileDto } from './dto/create-profile.dto';
import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateServiceDto } from './dto/update-service.dto';

const PROFILE_LIST_SELECT = {
  id: true,
  clinicId: true,
  userId: true,
  slug: true,
  displayName: true,
  avatarUrl: true,
  isPublished: true,
  viewsCount: true,
  city: true,
  state: true,
  createdAt: true,
  updatedAt: true,
} as const;

const PROFILE_DETAIL_INCLUDE = {
  services: { orderBy: { displayOrder: 'asc' as const } },
  profileSpecialties: { include: { specialty: true } },
} as const;

@Injectable()
export class ProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(clinicId: string, dto: CreateProfileDto) {
    await this.assertSlugAvailable(dto.slug);

    return this.prisma.profile.create({
      data: {
        clinicId,
        displayName: dto.displayName,
        slug: dto.slug,
        bio: dto.bio,
        crmNumber: dto.crmNumber,
        crmState: dto.crmState,
        phone: dto.phone,
        whatsappNumber: dto.whatsappNumber,
        publicEmail: dto.publicEmail,
        instagramUrl: dto.instagramUrl,
        facebookUrl: dto.facebookUrl,
        websiteUrl: dto.websiteUrl,
        addressLine1: dto.addressLine1,
        city: dto.city,
        state: dto.state,
        postalCode: dto.postalCode,
      },
      include: PROFILE_DETAIL_INCLUDE,
    });
  }

  findAll(clinicId: string) {
    return this.prisma.profile.findMany({
      where: { clinicId },
      select: PROFILE_LIST_SELECT,
      orderBy: { createdAt: 'asc' },
    });
  }

  async findBySlug(slug: string) {
    const profile = await this.prisma.profile.findUnique({
      where: { slug, isPublished: true },
      include: {
        services: {
          where: { isActive: true },
          orderBy: { displayOrder: 'asc' },
        },
        profileSpecialties: { include: { specialty: true } },
      },
    });
    if (!profile) throw new NotFoundException('Profile not found');
    return profile;
  }

  async findById(clinicId: string, id: string) {
    const profile = await this.prisma.profile.findFirst({
      where: { id, clinicId },
      include: PROFILE_DETAIL_INCLUDE,
    });
    if (!profile) throw new NotFoundException('Profile not found');
    return profile;
  }

  async update(
    clinicId: string,
    callerId: string,
    callerRole: UserRole,
    id: string,
    dto: UpdateProfileDto,
  ) {
    const profile = await this.assertClinicOwnership(clinicId, id);

    if (callerRole === 'DENTIST' && profile.userId !== callerId) {
      throw new ForbiddenException(
        'Dentists can only update their own profile',
      );
    }

    if (dto.slug && dto.slug !== profile.slug) {
      await this.assertSlugAvailable(dto.slug);
    }

    return this.prisma.profile.update({
      where: { id },
      data: {
        displayName: dto.displayName,
        slug: dto.slug,
        bio: dto.bio,
        crmNumber: dto.crmNumber,
        crmState: dto.crmState,
        phone: dto.phone,
        whatsappNumber: dto.whatsappNumber,
        publicEmail: dto.publicEmail,
        instagramUrl: dto.instagramUrl,
        facebookUrl: dto.facebookUrl,
        websiteUrl: dto.websiteUrl,
        addressLine1: dto.addressLine1,
        city: dto.city,
        state: dto.state,
        postalCode: dto.postalCode,
      },
      include: PROFILE_DETAIL_INCLUDE,
    });
  }

  async togglePublish(clinicId: string, id: string) {
    const profile = await this.assertClinicOwnership(clinicId, id);
    return this.prisma.profile.update({
      where: { id },
      data: { isPublished: !profile.isPublished },
      select: { id: true, slug: true, isPublished: true },
    });
  }

  async remove(clinicId: string, id: string) {
    await this.assertClinicOwnership(clinicId, id);

    try {
      await this.prisma.profile.delete({ where: { id } });
    } catch (error) {
      if (isForeignKeyError(error)) {
        throw new ConflictException(
          'Profile cannot be deleted because it has related records',
        );
      }

      throw error;
    }
  }

  async createService(
    clinicId: string,
    profileId: string,
    dto: CreateServiceDto,
  ) {
    await this.assertClinicOwnership(clinicId, profileId);
    await this.assertServiceDisplayOrderAvailable(
      profileId,
      dto.displayOrder,
    );

    return this.prisma.service.create({
      data: {
        profileId,
        clinicId,
        name: dto.name,
        description: dto.description,
        priceFrom: dto.priceFrom,
        priceTo: dto.priceTo,
        durationMinutes: dto.durationMinutes,
        isPriceDisplayed: dto.isPriceDisplayed,
        isActive: dto.isActive,
        displayOrder: dto.displayOrder,
      },
    });
  }

  async updateService(
    clinicId: string,
    profileId: string,
    serviceId: string,
    dto: UpdateServiceDto,
  ) {
    await this.assertClinicOwnership(clinicId, profileId);
    await this.assertServiceOwnership(profileId, serviceId);
    await this.assertServiceDisplayOrderAvailable(
      profileId,
      dto.displayOrder,
      serviceId,
    );

    return this.prisma.service.update({
      where: { id: serviceId },
      data: {
        name: dto.name,
        description: dto.description,
        priceFrom: dto.priceFrom,
        priceTo: dto.priceTo,
        durationMinutes: dto.durationMinutes,
        isPriceDisplayed: dto.isPriceDisplayed,
        isActive: dto.isActive,
        displayOrder: dto.displayOrder,
      },
    });
  }

  async removeService(clinicId: string, profileId: string, serviceId: string) {
    await this.assertClinicOwnership(clinicId, profileId);
    await this.assertServiceOwnership(profileId, serviceId);
    await this.prisma.service.delete({ where: { id: serviceId } });
  }

  private async assertSlugAvailable(slug: string) {
    const existing = await this.prisma.profile.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (existing) throw new ConflictException('Slug is already taken');
  }

  private async assertClinicOwnership(clinicId: string, profileId: string) {
    const profile = await this.prisma.profile.findFirst({
      where: { id: profileId, clinicId },
      select: { id: true, userId: true, slug: true, isPublished: true },
    });
    if (!profile) throw new NotFoundException('Profile not found');
    return profile;
  }

  private async assertServiceOwnership(profileId: string, serviceId: string) {
    const service = await this.prisma.service.findFirst({
      where: { id: serviceId, profileId },
      select: { id: true },
    });
    if (!service) throw new NotFoundException('Service not found');
    return service;
  }

  private async assertServiceDisplayOrderAvailable(
    profileId: string,
    displayOrder: number | undefined,
    ignoredServiceId?: string,
  ) {
    if (displayOrder === undefined) return;

    const existing = await this.prisma.service.findFirst({
      where: {
        profileId,
        displayOrder,
        ...(ignoredServiceId ? { id: { not: ignoredServiceId } } : {}),
      },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException(
        'A service with this display order already exists for this profile',
      );
    }
  }
}

function isForeignKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2003'
  );
}
