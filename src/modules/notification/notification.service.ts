import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { NotificationChannel, NotificationScope, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import {
  INotificationProvider,
  NOTIFICATION_PROVIDER,
} from './providers/notification-provider.interface';
import { SendNotificationDto } from './dto/send-notification.dto';
import { CreateConsentDto, ListConsentsDto } from './dto/notification-consent.dto';
import { UpdatePreferenceDto } from './dto/notification-preference.dto';
import { ListMessagesDto } from './dto/list-messages.dto';

// Fallback monthly limits by plan slug when Plan.whatsappMonthlyLimit is NULL
const WHATSAPP_LIMIT_BY_SLUG: Record<string, number> = {
  starter: 0,
  professional: 50,
  premium: 300,
};

function getCurrentMonth(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}`;
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    @Inject(NOTIFICATION_PROVIDER)
    private readonly provider: INotificationProvider,
  ) {}

  // ─── Plan helpers ──────────────────────────────────────────────────────────

  private async getWhatsAppLimit(clinicId: string): Promise<number> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { clinicId },
      include: { plan: { select: { slug: true, hasWhatsApp: true, whatsappMonthlyLimit: true } } },
    });

    if (!subscription?.plan?.hasWhatsApp) {
      const slug = subscription?.plan?.slug ?? '';
      const fallback = WHATSAPP_LIMIT_BY_SLUG[slug] ?? 0;
      return fallback;
    }

    return subscription.plan.whatsappMonthlyLimit ?? WHATSAPP_LIMIT_BY_SLUG[subscription.plan.slug] ?? 0;
  }

  // ─── Quota ─────────────────────────────────────────────────────────────────

  async getQuota(clinicId: string) {
    const limit = await this.getWhatsAppLimit(clinicId);
    const month = getCurrentMonth();

    const quota = await this.prisma.notificationQuota.findUnique({
      where: { clinicId_month_channel: { clinicId, month, channel: 'WHATSAPP' } },
    });

    return {
      month,
      channel: 'WHATSAPP' as NotificationChannel,
      used: quota?.used ?? 0,
      limit,
      available: Math.max(0, limit - (quota?.used ?? 0)),
    };
  }

  private async incrementQuota(clinicId: string, month: string, limit: number): Promise<void> {
    await this.prisma.notificationQuota.upsert({
      where: { clinicId_month_channel: { clinicId, month, channel: 'WHATSAPP' } },
      update: { used: { increment: 1 } },
      create: { clinicId, month, channel: 'WHATSAPP', used: 1, limit },
    });
  }

  // ─── Templates ─────────────────────────────────────────────────────────────

  async listTemplates() {
    return this.prisma.notificationTemplate.findMany({
      where: { isActive: true, category: 'UTILITY' },
      orderBy: { slug: 'asc' },
      select: { id: true, slug: true, channel: true, category: true, bodyPt: true, variables: true },
    });
  }

  // ─── Preferences ───────────────────────────────────────────────────────────

  async getPreferences(clinicId: string) {
    const pref = await this.prisma.notificationPreference.findUnique({
      where: { clinicId },
    });

    return (
      pref ?? {
        clinicId,
        whatsappEnabled: false,
        autoReminder: false,
        autoConfirmation: false,
        reminderHoursBefore: 24,
        createdAt: null,
        updatedAt: null,
      }
    );
  }

  async updatePreferences(clinicId: string, dto: UpdatePreferenceDto) {
    return this.prisma.notificationPreference.upsert({
      where: { clinicId },
      update: {
        ...(dto.whatsappEnabled !== undefined && { whatsappEnabled: dto.whatsappEnabled }),
        ...(dto.autoReminder !== undefined && { autoReminder: dto.autoReminder }),
        ...(dto.autoConfirmation !== undefined && { autoConfirmation: dto.autoConfirmation }),
        ...(dto.reminderHoursBefore !== undefined && { reminderHoursBefore: dto.reminderHoursBefore }),
      },
      create: {
        clinicId,
        whatsappEnabled: dto.whatsappEnabled ?? false,
        autoReminder: dto.autoReminder ?? false,
        autoConfirmation: dto.autoConfirmation ?? false,
        reminderHoursBefore: dto.reminderHoursBefore ?? 24,
      },
    });
  }

  // ─── Consents ──────────────────────────────────────────────────────────────

  async listConsents(clinicId: string, dto: ListConsentsDto) {
    const where: Prisma.NotificationConsentWhereInput = {
      clinicId,
      ...(dto.phone && { phone: dto.phone.replace(/\D/g, '') }),
      ...(dto.channel && { channel: dto.channel }),
      ...(dto.scope && { scope: dto.scope }),
    };

    return this.prisma.notificationConsent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        phone: true,
        channel: true,
        scope: true,
        granted: true,
        grantedAt: true,
        revokedAt: true,
        source: true,
        patientUserId: true,
        entityType: true,
        entityId: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async createOrUpdateConsent(
    clinicId: string,
    actorUserId: string,
    dto: CreateConsentDto,
  ) {
    const phone = dto.phone.replace(/\D/g, '');

    // Find existing consent to upsert
    const existing = await this.prisma.notificationConsent.findFirst({
      where: { clinicId, phone, channel: dto.channel, scope: dto.scope },
    });

    const now = new Date();
    let consent: { id: string; granted: boolean };

    if (existing) {
      consent = await this.prisma.notificationConsent.update({
        where: { id: existing.id },
        data: {
          granted: dto.granted,
          grantedAt: dto.granted ? now : existing.grantedAt,
          revokedAt: dto.granted ? null : now,
          source: dto.source,
          ...(dto.patientUserId && { patientUserId: dto.patientUserId }),
          ...(dto.entityType && { entityType: dto.entityType }),
          ...(dto.entityId && { entityId: dto.entityId }),
        },
        select: { id: true, granted: true },
      });
    } else {
      consent = await this.prisma.notificationConsent.create({
        data: {
          clinicId,
          phone,
          channel: dto.channel,
          scope: dto.scope,
          granted: dto.granted,
          grantedAt: dto.granted ? now : null,
          revokedAt: dto.granted ? null : now,
          source: dto.source,
          patientUserId: dto.patientUserId ?? null,
          entityType: dto.entityType ?? null,
          entityId: dto.entityId ?? null,
        },
        select: { id: true, granted: true },
      });
    }

    await this.auditLog.log({
      actorUserId,
      clinicId,
      action: dto.granted ? 'NOTIFICATION_CONSENT_GRANTED' : 'NOTIFICATION_CONSENT_REVOKED',
      entityType: 'notification_consent',
      entityId: consent.id,
      metadata: { phone, channel: dto.channel, scope: dto.scope },
    });

    return consent;
  }

  async revokeConsent(clinicId: string, consentId: string, actorUserId: string) {
    const consent = await this.prisma.notificationConsent.findUnique({
      where: { id: consentId },
      select: { id: true, clinicId: true, phone: true, channel: true, scope: true },
    });

    if (!consent || consent.clinicId !== clinicId) {
      throw new NotFoundException('Consentimento não encontrado.');
    }

    const updated = await this.prisma.notificationConsent.update({
      where: { id: consentId },
      data: { granted: false, revokedAt: new Date() },
    });

    await this.auditLog.log({
      actorUserId,
      clinicId,
      action: 'NOTIFICATION_CONSENT_REVOKED',
      entityType: 'notification_consent',
      entityId: consentId,
      metadata: { phone: consent.phone, channel: consent.channel, scope: consent.scope },
    });

    return updated;
  }

  // ─── Messages ──────────────────────────────────────────────────────────────

  async listMessages(clinicId: string, dto: ListMessagesDto) {
    const page = dto.page ?? 1;
    const limit = Math.min(dto.limit ?? 20, 100);
    const skip = (page - 1) * limit;

    const where: Prisma.NotificationMessageWhereInput = {
      clinicId,
      ...(dto.appointmentId && { appointmentId: dto.appointmentId }),
    };

    const [data, total] = await Promise.all([
      this.prisma.notificationMessage.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          templateSlug: true,
          channel: true,
          scope: true,
          status: true,
          appointmentId: true,
          sentAt: true,
          failedAt: true,
          failReason: true,
          createdAt: true,
        },
      }),
      this.prisma.notificationMessage.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // ─── Send ──────────────────────────────────────────────────────────────────

  async send(clinicId: string, actorUserId: string, dto: SendNotificationDto) {
    const phone = dto.phone.replace(/\D/g, '');

    // 1. Verify template exists and is UTILITY
    const template = await this.prisma.notificationTemplate.findUnique({
      where: { slug: dto.templateSlug },
      select: { id: true, isActive: true, category: true, channel: true },
    });

    if (!template || !template.isActive) {
      throw new NotFoundException(`Template "${dto.templateSlug}" não encontrado ou inativo.`);
    }

    if (template.category !== 'UTILITY') {
      throw new ForbiddenException('Apenas templates de categoria UTILITY estão disponíveis nesta fase.');
    }

    // 2. Validate appointment belongs to clinic (when provided)
    if (dto.appointmentId) {
      const appt = await this.prisma.appointment.findUnique({
        where: { id: dto.appointmentId },
        select: { clinicId: true },
      });
      if (!appt || appt.clinicId !== clinicId) {
        throw new NotFoundException('Agendamento não encontrado.');
      }
    }

    // 3. Check plan allows WhatsApp and get limit
    const limit = await this.getWhatsAppLimit(clinicId);
    if (limit === 0) {
      throw new ForbiddenException(
        'O plano atual não inclui envio de mensagens WhatsApp. Faça upgrade para continuar.',
      );
    }

    // 4. Check quota
    const month = getCurrentMonth();
    const quota = await this.prisma.notificationQuota.findUnique({
      where: { clinicId_month_channel: { clinicId, month, channel: 'WHATSAPP' } },
    });
    const used = quota?.used ?? 0;

    if (used >= limit) {
      throw new HttpException(
        `Limite mensal de ${limit} mensagens WhatsApp atingido. Aguarde o próximo mês ou faça upgrade.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // 5. Check consent
    const consent = await this.prisma.notificationConsent.findFirst({
      where: { clinicId, phone, channel: 'WHATSAPP', scope: 'UTILITY', granted: true, revokedAt: null },
      select: { id: true },
    });

    if (!consent) {
      throw new ForbiddenException(
        'Consentimento de WhatsApp não registrado para este número. Obtenha o consentimento antes de enviar.',
      );
    }

    // 6. Simulate send via provider
    let providerRef: string | null = null;
    const now = new Date();
    let status: 'SENT' | 'FAILED' = 'SENT';
    let failReason: string | null = null;

    try {
      const result = await this.provider.send({
        clinicId,
        consentId: consent.id,
        appointmentId: dto.appointmentId ?? null,
        templateSlug: dto.templateSlug,
        phone,
        channel: 'WHATSAPP',
        scope: 'UTILITY',
      });
      providerRef = result.providerRef;
    } catch (err) {
      status = 'FAILED';
      failReason = err instanceof Error ? err.message : 'Falha no provedor';
      this.logger.error(`Send failed for template ${dto.templateSlug}`, err);
    }

    // 7. Persist message record (no body stored)
    const message = await this.prisma.notificationMessage.create({
      data: {
        clinicId,
        consentId: consent.id,
        appointmentId: dto.appointmentId ?? null,
        templateSlug: dto.templateSlug,
        channel: 'WHATSAPP',
        scope: 'UTILITY',
        status,
        providerRef,
        sentAt: status === 'SENT' ? now : null,
        failedAt: status === 'FAILED' ? now : null,
        failReason,
      },
      select: { id: true, status: true, templateSlug: true, sentAt: true },
    });

    // 8. Increment quota only on success
    if (status === 'SENT') {
      await this.incrementQuota(clinicId, month, limit);
    }

    // 9. Audit log
    await this.auditLog.log({
      actorUserId,
      clinicId,
      action: 'NOTIFICATION_SENT',
      entityType: 'notification_message',
      entityId: message.id,
      metadata: {
        templateSlug: dto.templateSlug,
        channel: 'WHATSAPP',
        scope: 'UTILITY' as NotificationScope,
        appointmentId: dto.appointmentId ?? null,
        status,
        simulated: true,
      },
    });

    return message;
  }
}
