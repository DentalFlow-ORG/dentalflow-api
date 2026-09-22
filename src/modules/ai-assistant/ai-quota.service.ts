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
import { getPlanFeatures, PlanFeature } from '../billing/plan-feature.types';
import {
  brazilCurrentIsoMonth,
  getBrazilMonthRange,
} from '../../common/utils/brazil-timezone';

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

type PlanLimits = {
  allowed: boolean;
  perTypeMonthly: number;
  /** Per-type overrides that take precedence over perTypeMonthly for specific types. */
  typeOverrides?: Record<string, number>;
};

/** Per-type-per-month limits keyed by Plan.slug */
const AI_PLAN_LIMITS: Record<string, PlanLimits> = {
  starter: { allowed: false, perTypeMonthly: 0 },
  professional: {
    allowed: true,
    perTypeMonthly: 1,
    typeOverrides: {
      STOCK_COPILOT: 10,
      ABNORMAL_CONSUMPTION_COPILOT: 10,
      EXPENSE_CLASSIFICATION: 30,
      MONTHLY_FINANCE_DIAGNOSIS: 5,
      CLINICAL_DICTATION: 0,
    },
  },
  premium: {
    allowed: true,
    perTypeMonthly: 10,
    typeOverrides: {
      STOCK_COPILOT: 30,
      ABNORMAL_CONSUMPTION_COPILOT: 30,
      EXPENSE_CLASSIFICATION: 100,
      MONTHLY_FINANCE_DIAGNOSIS: 20,
      CLINICAL_DICTATION: 30,
    },
  },
};
const DEFAULT_LIMITS: PlanLimits = { allowed: false, perTypeMonthly: 0 };

@Injectable()
export class AiQuotaService {
  constructor(private readonly prisma: PrismaService) {}

  async getQuota(
    clinicId: string,
    type: AiAssistantAnalysisType,
  ): Promise<AiQuotaInfo> {
    const { start, nextResetAt } = this.monthBounds();

    // Sequential awaits to ensure each query uses its own dedicated pg connection.
    // Running these concurrently with Promise.all can cause pg to dispatch multiple
    // queries to the same client before one resolves, triggering the pg@8 deprecation
    // warning "Calling client.query() when the client is already executing a query".
    const planKey = await this.getPlanKey(clinicId);
    const used = await this.countMonthlyUsed(
      clinicId,
      type,
      start,
      nextResetAt,
    );
    const lastRecord = await this.getLastSuccess(clinicId, type);

    const limits = planKey
      ? (AI_PLAN_LIMITS[planKey] ?? DEFAULT_LIMITS)
      : DEFAULT_LIMITS;
    const featureAllowed =
      type !== AiAssistantAnalysisType.CLINICAL_DICTATION ||
      getPlanFeatures(planKey).has(PlanFeature.CLINICAL_DICTATION);
    const effectiveLimits = featureAllowed ? limits : DEFAULT_LIMITS;
    const monthlyLimit =
      effectiveLimits.typeOverrides?.[type] ?? effectiveLimits.perTypeMonthly;
    const remaining = effectiveLimits.allowed
      ? Math.max(0, monthlyLimit - used)
      : 0;

    let blockedReason: string | null = null;
    if (!effectiveLimits.allowed) {
      blockedReason =
        'O assistente de IA não está disponível no seu plano atual. Faça upgrade para o plano Premium.';
    } else if (remaining === 0) {
      blockedReason = `Limite mensal de análises atingido. Renova em ${nextResetAt.toLocaleDateString('pt-BR', { timeZone: 'UTC' })}.`;
    }

    return {
      allowed: effectiveLimits.allowed,
      planKey,
      used,
      remaining,
      limit: monthlyLimit,
      nextResetAt: nextResetAt.toISOString(),
      lastGeneratedAt: lastRecord?.generatedAt.toISOString() ?? null,
      blockedReason,
    };
  }

  async assertQuota(
    clinicId: string,
    type: AiAssistantAnalysisType,
  ): Promise<void> {
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
        status: {
          in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING],
        },
      },
      select: { plan: { select: { slug: true } } },
    });
    return subscription?.plan?.slug ?? null;
  }

  private monthBounds(): { start: Date; nextResetAt: Date } {
    // generatedAt is a UTC timestamp — use Brazil month boundaries so quota
    // counting doesn't advance to the next month at 00:00 UTC while Brazil
    // is still in the previous calendar month.
    const { start, end } = getBrazilMonthRange(brazilCurrentIsoMonth());
    return { start, nextResetAt: end };
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

  private async getLastSuccess(
    clinicId: string,
    type: AiAssistantAnalysisType,
  ) {
    return this.prisma.aiAssistantAnalysis.findFirst({
      where: { clinicId, type, status: AiAssistantAnalysisStatus.SUCCESS },
      orderBy: { generatedAt: 'desc' },
      select: { generatedAt: true },
    });
  }
}
