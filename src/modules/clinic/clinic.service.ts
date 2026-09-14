import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateClinicProfileDto } from './dto/update-clinic-profile.dto';

const PROFILE_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  logoUrl: true,
  websiteUrl: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  state: true,
  country: true,
  postalCode: true,
  timezone: true,
  createdAt: true,
} as const;

@Injectable()
export class ClinicService {
  constructor(private readonly prisma: PrismaService) {}

  getProfile(clinicId: string) {
    return this.prisma.clinic.findUniqueOrThrow({
      where: { id: clinicId },
      select: PROFILE_SELECT,
    });
  }

  updateProfile(clinicId: string, dto: UpdateClinicProfileDto) {
    return this.prisma.clinic.update({
      where: { id: clinicId },
      data: dto,
      select: PROFILE_SELECT,
    });
  }
}
