import {
  BadRequestException,
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
    await this.assertProfileLimit(clinicId);
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

  findAll(clinicId: string, callerId: string, callerRole: UserRole) {
    return this.prisma.profile.findMany({
      where: {
        clinicId,
        ...(callerRole === 'DENTIST' ? { userId: callerId } : {}),
      },
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
    if (!profile) throw new NotFoundException('Perfil profissional não encontrado');
    return profile;
  }

  async findById(
    clinicId: string,
    callerId: string,
    callerRole: UserRole,
    id: string,
  ) {
    const profile = await this.prisma.profile.findFirst({
      where: { id, clinicId },
      include: PROFILE_DETAIL_INCLUDE,
    });
    if (!profile) throw new NotFoundException('Perfil profissional não encontrado');
    if (callerRole === 'DENTIST' && profile.userId !== callerId) {
      throw new ForbiddenException(
        'Profissionais podem acessar apenas o próprio perfil',
      );
    }
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
        'Profissionais podem atualizar apenas o próprio perfil',
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
          'Perfil não pode ser excluído porque possui registros relacionados',
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
    await this.assertServiceLimit(clinicId, profileId);
    await this.assertServiceDisplayOrderAvailable(profileId, dto.displayOrder);

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
        estimatedDirectCostCents: dto.estimatedDirectCostCents,
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
        estimatedDirectCostCents: dto.estimatedDirectCostCents,
      },
    });
  }

  async removeService(clinicId: string, profileId: string, serviceId: string) {
    await this.assertClinicOwnership(clinicId, profileId);
    await this.assertServiceOwnership(profileId, serviceId);

    const [appointmentCount, transactionCount] = await Promise.all([
      this.prisma.appointment.count({ where: { serviceId } }),
      this.prisma.financialTransaction.count({ where: { serviceId } }),
    ]);

    if (appointmentCount > 0 || transactionCount > 0) {
      throw new ConflictException(
        'Este serviço possui registros vinculados e não pode ser removido.',
      );
    }

    await this.prisma.service.delete({ where: { id: serviceId } });
  }

  async setSpecialties(
    clinicId: string,
    callerId: string,
    callerRole: UserRole,
    profileId: string,
    specialtyIds: string[],
  ) {
    const profile = await this.assertClinicOwnership(clinicId, profileId);

    if (callerRole === 'DENTIST' && profile.userId !== callerId) {
      throw new ForbiddenException(
        'Profissionais podem atualizar apenas o próprio perfil',
      );
    }

    if (specialtyIds.length > 0) {
      const found = await this.prisma.specialty.findMany({
        where: { id: { in: specialtyIds } },
        select: { id: true },
      });
      if (found.length !== specialtyIds.length) {
        throw new BadRequestException('Uma ou mais especialidades são inválidas');
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.profileSpecialty.deleteMany({ where: { profileId } });
      if (specialtyIds.length > 0) {
        await tx.profileSpecialty.createMany({
          data: specialtyIds.map((specialtyId) => ({ profileId, specialtyId })),
          skipDuplicates: true,
        });
      }
    });

    return this.prisma.profileSpecialty.findMany({
      where: { profileId },
      include: { specialty: true },
    });
  }

  private async assertProfileLimit(clinicId: string) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { clinicId },
      select: { plan: { select: { maxProfiles: true } } },
    });

    const maxProfiles = subscription?.plan?.maxProfiles ?? null;
    if (maxProfiles === null) return;

    const count = await this.prisma.profile.count({ where: { clinicId } });
    if (count >= maxProfiles) {
      throw new ForbiddenException(
        `Limite de ${maxProfiles} perfis atingido para o plano atual`,
      );
    }
  }

  private async assertServiceLimit(clinicId: string, profileId: string) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { clinicId },
      select: { plan: { select: { maxServicesPerProfile: true } } },
    });

    const maxServices = subscription?.plan?.maxServicesPerProfile ?? null;
    if (maxServices === null) return;

    const count = await this.prisma.service.count({ where: { profileId } });
    if (count >= maxServices) {
      throw new ForbiddenException(
        `Limite de ${maxServices} serviços por perfil atingido para o plano atual`,
      );
    }
  }

  private async assertSlugAvailable(slug: string) {
    const existing = await this.prisma.profile.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (existing) throw new ConflictException('Este slug já está em uso');
  }

  private async assertClinicOwnership(clinicId: string, profileId: string) {
    const profile = await this.prisma.profile.findFirst({
      where: { id: profileId, clinicId },
      select: { id: true, userId: true, slug: true, isPublished: true },
    });
    if (!profile) throw new NotFoundException('Perfil profissional não encontrado');
    return profile;
  }

  private async assertServiceOwnership(profileId: string, serviceId: string) {
    const service = await this.prisma.service.findFirst({
      where: { id: serviceId, profileId },
      select: { id: true },
    });
    if (!service) throw new NotFoundException('Serviço não encontrado');
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
        'Já existe um serviço com esta ordem de exibição para este perfil',
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
