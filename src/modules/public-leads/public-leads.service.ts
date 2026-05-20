import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreatePublicLeadDto } from './dto/create-public-lead.dto';

const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const SUCCESS_MESSAGE = 'Recebemos seu contato. Em breve um especialista falará com você.';

@Injectable()
export class PublicLeadsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreatePublicLeadDto, rawIp: string | undefined): Promise<{ success: true; message: string }> {
    const since = new Date(Date.now() - DUPLICATE_WINDOW_MS);
    const existing = await this.prisma.websiteLead.findFirst({
      where: { phone: dto.phone, createdAt: { gte: since } },
      select: { id: true },
    });

    if (!existing) {
      const ipHash = rawIp
        ? createHash('sha256').update(rawIp).digest('hex')
        : null;

      await this.prisma.websiteLead.create({
        data: {
          name: dto.name,
          phone: dto.phone,
          clinicName: dto.clinicName,
          preferredTime: dto.preferredTime,
          context: dto.context,
          consentGiven: dto.acceptedPrivacyPolicy,
          consentAt: dto.acceptedPrivacyPolicy ? new Date() : null,
          ipHash,
        },
      });
    }

    return { success: true, message: SUCCESS_MESSAGE };
  }
}
