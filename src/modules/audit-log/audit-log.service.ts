import { Injectable, Logger } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { createHash } from 'crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { ListAuditLogsDto } from './dto/list-audit-logs.dto';
import { parseBrazilDateOnlyToUtcRange } from '../../common/utils/brazil-timezone';

export type CreateAuditLogInput = {
  actorUserId?: string | null;
  clinicId?: string | null;
  action: AuditAction;
  entityType?: string;
  entityId?: string;
  /** Keep small — no clinical notes, no tokens, no passwords */
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
};

function hashIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  return createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(dto: ListAuditLogsDto) {
    const page = dto.page ?? 1;
    const limit = Math.min(dto.limit ?? 20, 100);
    const skip = (page - 1) * limit;

    const where: Prisma.AuditLogWhereInput = {
      ...(dto.action && { action: dto.action }),
      ...(dto.actorUserId && { actorUserId: dto.actorUserId }),
      ...(dto.clinicId && { clinicId: dto.clinicId }),
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
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          actorUserId: true,
          clinicId: true,
          action: true,
          entityType: true,
          entityId: true,
          metadata: true,
          ipHash: true,
          createdAt: true,
          // userAgent omitted — not useful for dashboard display
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async log(input: CreateAuditLogInput): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorUserId: input.actorUserId ?? null,
          clinicId: input.clinicId ?? null,
          action: input.action,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          metadata: input.metadata
            ? (input.metadata as Prisma.InputJsonValue)
            : undefined,
          ipHash: hashIp(input.ipAddress),
          userAgent: input.userAgent ? input.userAgent.slice(0, 512) : null,
        },
      });
    } catch (err) {
      // Audit log failure must never break the main flow
      this.logger.error('Failed to write audit log', {
        action: input.action,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
