import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, PrivacyRequestStatus, UserRole } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthUser } from '../../common/types/auth-user.type';
import { CreatePrivacyRequestDto } from './dto/create-privacy-request.dto';
import { ListCookieConsentsDto } from './dto/list-cookie-consents.dto';
import { ListPrivacyRequestsDto } from './dto/list-privacy-requests.dto';
import { UpdatePrivacyRequestStatusDto } from './dto/update-privacy-request-status.dto';
import { LogCookieConsentDto } from './dto/log-cookie-consent.dto';
import { parseBrazilDateOnlyToUtcRange } from '../../common/utils/brazil-timezone';

function generateRequestCode(): string {
  return `PR-${randomBytes(4).toString('hex').toUpperCase()}`;
}

function hashIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  return createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

function truncateUserAgent(ua: string | undefined): string | undefined {
  if (!ua) return undefined;
  return ua.slice(0, 512);
}

@Injectable()
export class PrivacyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  // ── Public: create request ───────────────────────────────────────────────

  async createRequest(
    dto: CreatePrivacyRequestDto,
    meta: { ipAddress?: string; userAgent?: string },
  ) {
    if (!dto.identityConfirmationAccepted) {
      throw new BadRequestException(
        'Você precisa confirmar que autoriza a verificação de identidade para prosseguir.',
      );
    }

    const requestCode = generateRequestCode();

    const created = await this.prisma.privacyRequest.create({
      data: {
        requestCode,
        requesterName: dto.requesterName,
        requesterEmail: dto.requesterEmail,
        requesterType: dto.requesterType,
        clinicName: dto.clinicName ?? null,
        requestType: dto.requestType,
        description: dto.description,
        identityConfirmationAccepted: dto.identityConfirmationAccepted,
        status: 'OPEN',
      },
      select: { id: true, requestCode: true, createdAt: true },
    });

    await this.auditLog.log({
      action: 'PRIVACY_REQUEST_CREATED',
      entityType: 'PrivacyRequest',
      entityId: created.id,
      metadata: { requestCode, requestType: dto.requestType, requesterType: dto.requesterType },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return {
      requestCode: created.requestCode,
      message:
        `Sua solicitação foi registrada com sucesso. Código: ${requestCode}. ` +
        `Entraremos em contato pelo e-mail informado após validação da identidade.`,
    };
  }

  // ── Protected: list requests (ADMIN only) ───────────────────────────────
  // OWNER access is intentionally disabled: scoping requires a trusted clinicId FK on
  // PrivacyRequest (field not yet present). Re-enable only after the patient portal ships
  // and requests are linked to a clinic via clinicId, not the free-text clinicName field.

  async listRequests(actor: AuthUser, dto: ListPrivacyRequestsDto = {}) {
    const page = dto.page ?? 1;
    const limit = Math.min(dto.limit ?? 20, 100);
    const skip = (page - 1) * limit;

    this.assertAdmin(actor);

    const where: Prisma.PrivacyRequestWhereInput = {
      ...(dto.status && { status: dto.status }),
      ...(dto.requestType && { requestType: dto.requestType }),
      ...(dto.requesterType && { requesterType: dto.requesterType }),
      ...(dto.search && {
        OR: [
          { requestCode: { contains: dto.search, mode: 'insensitive' } },
          { requesterEmail: { contains: dto.search, mode: 'insensitive' } },
          { requesterName: { contains: dto.search, mode: 'insensitive' } },
        ],
      }),
    };

    const [data, total] = await Promise.all([
      this.prisma.privacyRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          requestCode: true,
          requesterName: true,
          requesterEmail: true,
          requesterType: true,
          clinicName: true,
          requestType: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.privacyRequest.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // ── Protected: get single request (ADMIN only) ──────────────────────────

  async getRequest(id: string, actor: AuthUser) {
    this.assertAdmin(actor);

    const request = await this.prisma.privacyRequest.findUnique({
      where: { id },
    });

    if (!request) throw new NotFoundException('Solicitação não encontrada.');

    return request;
  }

  // ── Protected: update status ─────────────────────────────────────────────

  async updateStatus(
    id: string,
    dto: UpdatePrivacyRequestStatusDto,
    actor: AuthUser,
    meta: { ipAddress?: string; userAgent?: string },
  ) {
    const request = await this.prisma.privacyRequest.findUnique({
      where: { id },
      select: { id: true, requestCode: true, status: true },
    });
    if (!request) throw new NotFoundException('Solicitação não encontrada.');

    // Only ADMIN for now — OWNER scoping requires stronger linkage
    this.assertAdmin(actor);

    const previousStatus = request.status;

    const updated = await this.prisma.privacyRequest.update({
      where: { id },
      data: {
        status: dto.status,
        responseNotes: dto.responseNotes ?? undefined,
        completedAt:
          dto.status === PrivacyRequestStatus.COMPLETED ||
          dto.status === PrivacyRequestStatus.REJECTED
            ? new Date()
            : undefined,
      },
      select: {
        id: true,
        requestCode: true,
        status: true,
        responseNotes: true,
        completedAt: true,
        updatedAt: true,
      },
    });

    await this.auditLog.log({
      actorUserId: actor.id,
      action: 'PRIVACY_REQUEST_STATUS_CHANGED',
      entityType: 'PrivacyRequest',
      entityId: id,
      metadata: { previousStatus, newStatus: dto.status, requestCode: request.requestCode },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return updated;
  }

  // ── Protected: respond to request ────────────────────────────────────────

  async respondToRequest(
    id: string,
    responseNotes: string,
    actor: AuthUser,
    meta: { ipAddress?: string; userAgent?: string },
  ) {
    const request = await this.prisma.privacyRequest.findUnique({
      where: { id },
      select: { id: true, requestCode: true },
    });
    if (!request) throw new NotFoundException('Solicitação não encontrada.');

    this.assertAdmin(actor);

    const updated = await this.prisma.privacyRequest.update({
      where: { id },
      data: {
        responseNotes,
        status: PrivacyRequestStatus.COMPLETED,
        completedAt: new Date(),
      },
      select: { id: true, requestCode: true, status: true, responseNotes: true, completedAt: true },
    });

    await this.auditLog.log({
      actorUserId: actor.id,
      action: 'PRIVACY_REQUEST_RESPONDED',
      entityType: 'PrivacyRequest',
      entityId: id,
      metadata: { requestCode: request.requestCode },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return updated;
  }

  // ── Protected: list cookie consent logs (ADMIN only) ────────────────────

  async listCookieConsents(dto: ListCookieConsentsDto) {
    const page = dto.page ?? 1;
    const limit = Math.min(dto.limit ?? 20, 100);
    const skip = (page - 1) * limit;

    const where: Prisma.CookieConsentLogWhereInput = {
      ...(dto.source && { source: dto.source }),
      ...(dto.policyVersion && { policyVersion: dto.policyVersion }),
      ...(dto.userId && { userId: dto.userId }),
      ...((dto.dateFrom || dto.dateTo) && {
        createdAt: {
          ...(dto.dateFrom && {
            gte: parseBrazilDateOnlyToUtcRange(dto.dateFrom).start,
          }),
          ...(dto.dateTo && {
            lt: parseBrazilDateOnlyToUtcRange(dto.dateTo).end,
          }),
        },
      }),
    };

    const [data, total] = await Promise.all([
      this.prisma.cookieConsentLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          userId: true,
          anonymousId: true,
          categories: true,
          policyVersion: true,
          source: true,
          ipHash: true,
          createdAt: true,
          // userAgent omitted — not necessary for compliance dashboard
        },
      }),
      this.prisma.cookieConsentLog.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // ── Public: log cookie consent ───────────────────────────────────────────

  async logCookieConsent(
    dto: LogCookieConsentDto,
    meta: { userId?: string; ipAddress?: string; userAgent?: string },
  ) {
    await this.prisma.cookieConsentLog.create({
      data: {
        userId: meta.userId ?? null,
        anonymousId: dto.anonymousId ?? null,
        categories: dto.categories as object,
        policyVersion: dto.policyVersion,
        source: dto.source,
        ipHash: hashIp(meta.ipAddress),
        userAgent: truncateUserAgent(meta.userAgent),
      },
    });

    await this.auditLog.log({
      actorUserId: meta.userId,
      action: 'COOKIE_CONSENT_RECORDED',
      metadata: {
        policyVersion: dto.policyVersion,
        source: dto.source,
        categories: dto.categories,
      },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private assertAdmin(actor: AuthUser): void {
    if (actor.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Você não tem permissão para esta ação.');
    }
  }
}
