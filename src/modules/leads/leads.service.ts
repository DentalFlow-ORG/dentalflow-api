import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { LeadActivityAction, LeadStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { CreateLeadDto } from './dto/create-lead.dto';
import { CreateLeadActivityDto } from './dto/create-lead-activity.dto';
import { ListLeadsDto } from './dto/list-leads.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';
import { UpdateLeadStatusDto } from './dto/update-lead-status.dto';

const LEAD_SELECT = {
  id: true,
  clinicId: true,
  name: true,
  email: true,
  phone: true,
  source: true,
  status: true,
  message: true,
  nextFollowUpAt: true,
  assignedToUserId: true,
  serviceId: true,
  createdAt: true,
  updatedAt: true,
  assignedTo: { select: { id: true, firstName: true, lastName: true } },
  service: { select: { id: true, name: true } },
} as const;

const ACTIVITY_SELECT = {
  id: true,
  leadId: true,
  action: true,
  oldStatus: true,
  newStatus: true,
  note: true,
  createdAt: true,
  user: { select: { id: true, firstName: true, lastName: true } },
} as const;

@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async listLeads(clinicId: string, dto: ListLeadsDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 30;
    const skip = (page - 1) * limit;

    const where: Prisma.LeadWhereInput = { clinicId };

    if (dto.search?.trim()) {
      const term = dto.search.trim();
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
        { phone: { contains: term, mode: 'insensitive' } },
      ];
    }

    if (dto.status) where.status = dto.status;
    if (dto.source) where.source = dto.source;
    if (dto.assignedToUserId) where.assignedToUserId = dto.assignedToUserId;
    if (dto.hasFollowUp === true) where.nextFollowUpAt = { not: null };
    if (dto.hasFollowUp === false) where.nextFollowUpAt = null;

    const [data, total] = await Promise.all([
      this.prisma.lead.findMany({
        where,
        select: LEAD_SELECT,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.lead.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async getLeadSummary(clinicId: string) {
    const groups = await this.prisma.lead.groupBy({
      by: ['status'],
      where: { clinicId },
      _count: { _all: true },
    });

    const counts: Record<string, number> = {};
    for (const g of groups) {
      counts[g.status] = g._count._all;
    }

    return {
      new: counts['NEW'] ?? 0,
      contacted: counts['CONTACTED'] ?? 0,
      scheduled: counts['SCHEDULED'] ?? 0,
      converted: counts['CONVERTED'] ?? 0,
      lost: counts['LOST'] ?? 0,
      archived: counts['ARCHIVED'] ?? 0,
    };
  }

  async findById(clinicId: string, leadId: string) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, clinicId },
      select: LEAD_SELECT,
    });

    if (!lead) throw new NotFoundException('Lead não encontrado');

    return lead;
  }

  async createLead(clinicId: string, userId: string, dto: CreateLeadDto) {
    await this.assertQuotaNotExceeded(clinicId);

    const profile = await this.resolveProfile(clinicId);

    if (dto.serviceId) {
      await this.assertServiceInClinic(clinicId, dto.serviceId);
    }

    if (dto.assignedToUserId) {
      await this.assertUserInClinic(clinicId, dto.assignedToUserId);
    }

    const lead = await this.prisma.lead.create({
      data: {
        clinicId,
        profileId: profile.id,
        name: dto.name,
        email: dto.email,
        phone: dto.phone,
        source: dto.source ?? 'MANUAL',
        message: dto.message,
        serviceId: dto.serviceId,
        assignedToUserId: dto.assignedToUserId,
        nextFollowUpAt: dto.nextFollowUpAt ? new Date(dto.nextFollowUpAt) : null,
        activities: {
          create: {
            userId,
            action: 'CREATED' as LeadActivityAction,
          },
        },
      },
      select: LEAD_SELECT,
    });

    void this.auditLog.log({
      actorUserId: userId,
      clinicId,
      action: 'LEAD_CREATED',
      entityType: 'Lead',
      entityId: lead.id,
      metadata: { source: lead.source },
    });

    return lead;
  }

  async updateLead(clinicId: string, userId: string, leadId: string, dto: UpdateLeadDto) {
    await this.assertLeadInClinic(clinicId, leadId);

    if (dto.serviceId) {
      await this.assertServiceInClinic(clinicId, dto.serviceId);
    }

    if (dto.assignedToUserId) {
      await this.assertUserInClinic(clinicId, dto.assignedToUserId);
    }

    const updateData: Prisma.LeadUpdateInput = {};
    if (dto.name !== undefined) updateData.name = dto.name;
    if (dto.email !== undefined) updateData.email = dto.email;
    if (dto.phone !== undefined) updateData.phone = dto.phone;
    if (dto.source !== undefined) updateData.source = dto.source;
    if (dto.message !== undefined) updateData.message = dto.message;
    if (dto.serviceId !== undefined) {
      updateData.service = dto.serviceId
        ? { connect: { id: dto.serviceId } }
        : { disconnect: true };
    }
    if (dto.assignedToUserId !== undefined) {
      updateData.assignedTo = dto.assignedToUserId
        ? { connect: { id: dto.assignedToUserId } }
        : { disconnect: true };
    }
    if (dto.nextFollowUpAt !== undefined) {
      updateData.nextFollowUpAt = dto.nextFollowUpAt ? new Date(dto.nextFollowUpAt) : null;
    }

    const lead = await this.prisma.lead.update({
      where: { id: leadId },
      data: updateData,
      select: LEAD_SELECT,
    });

    void this.auditLog.log({
      actorUserId: userId,
      clinicId,
      action: 'LEAD_UPDATED',
      entityType: 'Lead',
      entityId: leadId,
    });

    return lead;
  }

  async updateLeadStatus(
    clinicId: string,
    userId: string,
    leadId: string,
    dto: UpdateLeadStatusDto,
  ) {
    const lead = await this.assertLeadInClinic(clinicId, leadId);

    if (lead.status === dto.status) {
      throw new BadRequestException('Lead já está neste status');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const updatedLead = await tx.lead.update({
        where: { id: leadId },
        data: { status: dto.status },
        select: LEAD_SELECT,
      });

      await tx.leadActivity.create({
        data: {
          leadId,
          userId,
          action: 'STATUS_CHANGED' as LeadActivityAction,
          oldStatus: lead.status as LeadStatus,
          newStatus: dto.status,
        },
      });

      return updatedLead;
    });

    void this.auditLog.log({
      actorUserId: userId,
      clinicId,
      action: 'LEAD_STATUS_CHANGED',
      entityType: 'Lead',
      entityId: leadId,
      metadata: { from: lead.status, to: dto.status },
    });

    return updated;
  }

  async addActivity(
    clinicId: string,
    userId: string,
    leadId: string,
    dto: CreateLeadActivityDto,
  ) {
    await this.assertLeadInClinic(clinicId, leadId);

    if (dto.action === 'NOTE_ADDED' && !dto.note?.trim()) {
      throw new BadRequestException('A nota é obrigatória para esta ação');
    }

    const activity = await this.prisma.leadActivity.create({
      data: {
        leadId,
        userId,
        action: dto.action,
        note: dto.note,
      },
      select: ACTIVITY_SELECT,
    });

    void this.auditLog.log({
      actorUserId: userId,
      clinicId,
      action: 'LEAD_ACTIVITY_CREATED',
      entityType: 'Lead',
      entityId: leadId,
      metadata: { activityAction: dto.action },
    });

    return activity;
  }

  async listActivities(clinicId: string, leadId: string) {
    await this.assertLeadInClinic(clinicId, leadId);

    return this.prisma.leadActivity.findMany({
      where: { leadId },
      select: ACTIVITY_SELECT,
      orderBy: { createdAt: 'asc' },
    });
  }

  async convertLead(clinicId: string, userId: string, leadId: string) {
    const lead = await this.assertLeadInClinic(clinicId, leadId);

    if (lead.status === 'CONVERTED') {
      throw new UnprocessableEntityException('Lead já foi convertido');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const updatedLead = await tx.lead.update({
        where: { id: leadId },
        data: { status: 'CONVERTED' },
        select: LEAD_SELECT,
      });

      await tx.leadActivity.create({
        data: {
          leadId,
          userId,
          action: 'STATUS_CHANGED' as LeadActivityAction,
          oldStatus: lead.status as LeadStatus,
          newStatus: 'CONVERTED',
        },
      });

      return updatedLead;
    });

    void this.auditLog.log({
      actorUserId: userId,
      clinicId,
      action: 'LEAD_CONVERTED',
      entityType: 'Lead',
      entityId: leadId,
    });

    return updated;
  }

  async archiveLead(clinicId: string, userId: string, leadId: string) {
    const lead = await this.assertLeadInClinic(clinicId, leadId);

    if (lead.status === 'ARCHIVED') {
      throw new BadRequestException('Lead já está arquivado');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const updatedLead = await tx.lead.update({
        where: { id: leadId },
        data: { status: 'ARCHIVED' },
        select: LEAD_SELECT,
      });

      await tx.leadActivity.create({
        data: {
          leadId,
          userId,
          action: 'STATUS_CHANGED' as LeadActivityAction,
          oldStatus: lead.status as LeadStatus,
          newStatus: 'ARCHIVED',
        },
      });

      return updatedLead;
    });

    void this.auditLog.log({
      actorUserId: userId,
      clinicId,
      action: 'LEAD_STATUS_CHANGED',
      entityType: 'Lead',
      entityId: leadId,
      metadata: { archived: true },
    });

    return updated;
  }

  private async resolveProfile(clinicId: string) {
    const profile = await this.prisma.profile.findFirst({
      where: { clinicId },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });

    if (!profile) {
      throw new UnprocessableEntityException(
        'A clínica não possui nenhum perfil cadastrado. Crie um perfil primeiro.',
      );
    }

    return profile;
  }

  private async assertLeadInClinic(clinicId: string, leadId: string) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, clinicId },
      select: { id: true, status: true },
    });

    if (!lead) throw new NotFoundException('Lead não encontrado');

    return lead;
  }

  private async assertServiceInClinic(clinicId: string, serviceId: string) {
    const service = await this.prisma.service.findFirst({
      where: { id: serviceId, clinicId },
      select: { id: true },
    });

    if (!service) throw new NotFoundException('Serviço não encontrado');
  }

  private async assertUserInClinic(clinicId: string, userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, clinicId, isActive: true },
      select: { id: true },
    });

    if (!user) throw new NotFoundException('Usuário não encontrado na clínica');
  }

  private async assertQuotaNotExceeded(clinicId: string) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { clinicId },
      select: { plan: { select: { maxLeadsPerMonth: true } } },
    });

    const limit = subscription?.plan?.maxLeadsPerMonth;
    if (limit == null) return;

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const count = await this.prisma.lead.count({
      where: {
        clinicId,
        createdAt: { gte: startOfMonth },
      },
    });

    if (count >= limit) {
      throw new UnprocessableEntityException(
        `Limite de ${limit} leads por mês atingido. Faça upgrade do plano para continuar.`,
      );
    }
  }
}
