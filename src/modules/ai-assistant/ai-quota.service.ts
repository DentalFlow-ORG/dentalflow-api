import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import {
  AiAssistantAnalysisStatus,
  AiAssistantAnalysisType,
  SubscriptionStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export type AiQuotaInfo = {
  allowed: boolean;
  planKey: string | null;
  used: number;
  remaining: number;
  limit: number;
  nextResetAt: string;
  lastGeneratedAt: string | null;
  blockedReason: string | null;
};

/** Per-type-per-month limits keyed by Plan.slug */
const AI_PLAN_LIMITS: Record<string, { allowed: boolean; perTypeMonthly: number }> = {
  starter: { allowed: false, perTypeMonthly: 0 },
  professional: { allowed: true, perTypeMonthly: 1 },
  premium: { allowed: true, perTypeMonthly: 10 },
};
const DEFAULT_LIMITS = { allowed: false, perTypeMonthly: 0 };

@Injectable()
export class AiQuotaService {
  constructor(private readonly prisma: PrismaService) {}

  async getQuota(clinicId: string, type: AiAssistantAnalysisType): Promise<AiQuotaInfo> {
    const { start, nextResetAt } = this.monthBounds();

    const [planKey, used, lastRecord] = await Promise.all([
      this.getPlanKey(clinicId),
      this.countMonthlyUsed(clinicId, type, start, nextResetAt),
      this.getLastSuccess(clinicId, type),
    ]);

    const limits = planKey ? (AI_PLAN_LIMITS[planKey] ?? DEFAULT_LIMITS) : DEFAULT_LIMITS;
    const remaining = limits.allowed ? Math.max(0, limits.perTypeMonthly - used) : 0;

    let blockedReason: string | null = null;
    if (!limits.allowed) {
      blockedReason =
        'O assistente de IA não está disponível no seu plano atual. Faça upgrade para o plano Premium.';
    } else if (remaining === 0) {
      blockedReason = `Limite mensal de análises atingido. Renova em ${nextResetAt.toLocaleDateString('pt-BR', { timeZone: 'UTC' })}.`;
    }

    return {
      allowed: limits.allowed,
      planKey,
      used,
      remaining,
      limit: limits.perTypeMonthly,
      nextResetAt: nextResetAt.toISOString(),
      lastGeneratedAt: lastRecord?.generatedAt.toISOString() ?? null,
      blockedReason,
    };
  }

  async assertQuota(clinicId: string, type: AiAssistantAnalysisType): Promise<void> {
    const quota = await this.getQuota(clinicId, type);
    if (!quota.allowed) {
      throw new ForbiddenException(
        'O assistente de IA não está disponível no seu plano atual. Faça upgrade para o plano Premium.',
      );
    }
    if (quota.remaining <= 0) {
      throw new HttpException(
        'Limite mensal de análises de IA atingido. Tente novamente no próximo mês.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async getPlanKey(clinicId: string): Promise<string | null> {
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        clinicId,
        status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING] },
      },
      select: { plan: { select: { slug: true } } },
    });
    return subscription?.plan?.slug ?? null;
  }

  private monthBounds(): { start: Date; nextResetAt: Date } {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    return {
      start: new Date(Date.UTC(year, month, 1)),
      nextResetAt: new Date(Date.UTC(year, month + 1, 1)),
    };
  }

  private async countMonthlyUsed(
    clinicId: string,
    type: AiAssistantAnalysisType,
    start: Date,
    end: Date,
  ): Promise<number> {
    return this.prisma.aiAssistantAnalysis.count({
      where: {
        clinicId,
        type,
        status: AiAssistantAnalysisStatus.SUCCESS,
        generatedAt: { gte: start, lt: end },
      },
    });
  }

  private async getLastSuccess(clinicId: string, type: AiAssistantAnalysisType) {
    return this.prisma.aiAssistantAnalysis.findFirst({
      where: { clinicId, type, status: AiAssistantAnalysisStatus.SUCCESS },
      orderBy: { generatedAt: 'desc' },
      select: { generatedAt: true },
    });
  }
}
