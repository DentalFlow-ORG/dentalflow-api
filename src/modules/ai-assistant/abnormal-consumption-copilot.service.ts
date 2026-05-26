import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AiAssistantAnalysisType } from '@prisma/client';
import OpenAI from 'openai';

import type {
  AbnormalConsumptionItem,
  AnomalyType,
} from '../stock/stock-abnormal-consumption.service';
import { StockAbnormalConsumptionService } from '../stock/stock-abnormal-consumption.service';
import { AiAssistantAnalysisRepository } from './ai-assistant-analysis.repository';
import { AiQuotaService } from './ai-quota.service';
import { AbnormalConsumptionCopilotDto } from './dto/abnormal-consumption-copilot.dto';

// ── Response types ─────────────────────────────────────────────────────────────

export type AbnormalConsumptionCopilotResult = {
  summary: string;
  highlights: string[];
  recommendedActions: string[];
  generatedAt: string;
  cached: boolean;
  source: 'AI' | 'CACHE';
  anomalySnapshot: AnomalySnapshot;
};

type AnomalySnapshot = {
  totalAnomalies: number;
  highSeverity: number;
  mediumSeverity: number;
  lowSeverity: number;
  recentDays: number;
  baselineDays: number;
  analyzedProducts: number;
};

type CopilotContent = {
  summary: string;
  highlights: string[];
  recommendedActions: string[];
};

// ── AI context types ───────────────────────────────────────────────────────────

type CompactAnomalyItem = {
  productName: string;
  anomalyType: string;
  severity: string;
  recentQuantity: number;
  baselineQuantity: number;
  changePercent: number | null;
  movementCount: number;
  reason: string;
  suggestedAction: string;
};

type CopilotContext = {
  generatedAt: string;
  anomalyAnalysis: {
    snapshot: AnomalySnapshot;
    items: CompactAnomalyItem[];
  };
  limitations: string[];
};

// ── Constants ──────────────────────────────────────────────────────────────────

const MAX_ITEMS_IN_CONTEXT = 10;

const ANOMALY_TYPE_PRIORITY: Record<AnomalyType, number> = {
  LOSS_SPIKE: 0,
  CONSUMPTION_SPIKE: 1,
  NEW_UNUSUAL_CONSUMPTION: 2,
  FREQUENT_ADJUSTMENTS: 3,
};

const SEVERITY_ORDER: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

const ANALYSIS_TYPE = AiAssistantAnalysisType.ABNORMAL_CONSUMPTION_COPILOT;

const COPILOT_SYSTEM_PROMPT = `Você é um assistente de gestão de estoque especializado em clínicas odontológicas brasileiras.

REGRAS ABSOLUTAS — siga-as sem exceção:
- Use SOMENTE os dados fornecidos no contexto JSON. Não invente produtos, quantidades ou situações.
- Se uma métrica não estiver no contexto, diga explicitamente que não há dados disponíveis.
- Não forneça aconselhamento médico ou odontológico.
- Não mencione pacientes, procedimentos, agendamentos ou dados clínicos.
- Não invente fornecedores, nomes de clínicas ou dados não fornecidos.
- Responda em português do Brasil, linguagem profissional e direta.
- Deixe claro que esses são indicadores operacionais, não prova de desperdício ou irregularidade.
- Se o array limitations não for vazio, reconheça a limitação de dados.
- Não exagere a gravidade — use tom calmo, orientado a negócio.

FORMATO DE RESPOSTA — JSON exato, sem markdown extra, sem texto fora do JSON:
{
  "summary": "string (2 a 4 frases sobre as variações detectadas)",
  "highlights": ["string", "string"],
  "recommendedActions": ["string", "string"]
}

REGRAS DE CONTEÚDO:
- summary: 2 a 4 frases, situação objetiva e acionável
- highlights: 2 a 4 pontos de atenção concretos, cite produtos ou tipos quando relevante
- recommendedActions: 2 a 4 ações práticas e específicas
- Tom: profissional, calmo, orientado a negócio, sem exageros`;

// ── Empty anomaly deterministic response ───────────────────────────────────────

const EMPTY_ANOMALY_CONTENT: CopilotContent = {
  summary:
    'Nenhum consumo fora do padrão foi encontrado no período analisado.',
  highlights: [
    'Não há produtos com variações relevantes de consumo, perda ou ajustes.',
    'A análise foi baseada nos movimentos registrados no estoque.',
  ],
  recommendedActions: [
    'Continue mantendo os lançamentos de entrada, saída e ajustes atualizados.',
    'Revise periodicamente os produtos de maior uso para manter o controle do estoque.',
  ],
};

// ── Service ────────────────────────────────────────────────────────────────────

@Injectable()
export class AbnormalConsumptionCopilotService {
  private readonly logger = new Logger(AbnormalConsumptionCopilotService.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly maxOutputTokens: number;

  constructor(
    private readonly abnormalConsumptionService: StockAbnormalConsumptionService,
    private readonly analysisRepository: AiAssistantAnalysisRepository,
    private readonly quotaService: AiQuotaService,
  ) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      this.logger.warn(
        'OPENAI_API_KEY not configured — consumption copilot disabled.',
      );
    }
    this.openai = new OpenAI({ apiKey: apiKey ?? 'not-configured' });
    this.model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
    this.maxOutputTokens = Number(
      process.env.OPENAI_AI_MAX_OUTPUT_TOKENS ?? 600,
    );
  }

  async getCopilotSummary(
    userId: string,
    clinicId: string,
    dto: AbnormalConsumptionCopilotDto,
  ): Promise<AbnormalConsumptionCopilotResult> {
    const forceRefresh = dto.forceRefresh ?? false;
    const recentDays = dto.recentDays ?? 14;
    const baselineDays = dto.baselineDays ?? 60;

    // 1. Deterministic data first — always cheap, no AI
    const consumptionResult =
      await this.abnormalConsumptionService.getAbnormalConsumption(clinicId, {
        recentDays,
        baselineDays,
      });

    const snapshot: AnomalySnapshot = {
      totalAnomalies: consumptionResult.summary.totalAnomalies,
      highSeverity: consumptionResult.summary.highSeverity,
      mediumSeverity: consumptionResult.summary.mediumSeverity,
      lowSeverity: consumptionResult.summary.lowSeverity,
      recentDays: consumptionResult.summary.recentDays,
      baselineDays: consumptionResult.summary.baselineDays,
      analyzedProducts: consumptionResult.summary.analyzedProducts,
    };

    // 2. Empty anomaly list — no AI, no quota
    if (snapshot.totalAnomalies === 0) {
      return {
        ...EMPTY_ANOMALY_CONTENT,
        generatedAt: new Date().toISOString(),
        cached: false,
        source: 'CACHE', // no AI was called
        anomalySnapshot: snapshot,
      };
    }

    // 3. Plan + quota check on ALL calls (including cache path)
    const quota = await this.quotaService.getQuota(clinicId, ANALYSIS_TYPE);
    if (!quota.allowed) {
      throw new ForbiddenException(
        'O Copiloto de consumo está disponível nos planos Professional e Premium.',
      );
    }

    // 4. Cache path — only when not forcing refresh
    if (!forceRefresh) {
      const cached = await this.findTodayCache(clinicId);
      if (cached) {
        const content = cached.content as CopilotContent;
        return {
          ...content,
          generatedAt: cached.generatedAt.toISOString(),
          cached: true,
          source: 'CACHE',
          anomalySnapshot: snapshot,
        };
      }
      // No same-day cache and no auto-AI: return null signal via HTTP 204 (handled by controller)
      return null as unknown as AbnormalConsumptionCopilotResult;
    }

    // 5. Fresh AI call — quota remaining check
    if (quota.remaining <= 0) {
      throw new HttpException(
        quota.blockedReason ??
          'Limite mensal de análises de IA atingido. Tente novamente no próximo mês.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    this.assertEnabled();

    // 6. Build compact context and call AI
    const context = this.buildContext(consumptionResult.items, snapshot);
    const content = await this.callOpenAi(userId, clinicId, context);

    return {
      ...content,
      generatedAt: new Date().toISOString(),
      cached: false,
      source: 'AI',
      anomalySnapshot: snapshot,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async findTodayCache(clinicId: string) {
    const record = await this.analysisRepository.findLatest(
      clinicId,
      ANALYSIS_TYPE,
    );
    if (!record) return null;
    const todayUtc = new Date();
    todayUtc.setUTCHours(0, 0, 0, 0);
    return record.generatedAt >= todayUtc ? record : null;
  }

  private buildContext(
    items: AbnormalConsumptionItem[],
    snapshot: AnomalySnapshot,
  ): CopilotContext {
    const sorted = [...items].sort((a, b) => {
      const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      if (sev !== 0) return sev;
      return (
        ANOMALY_TYPE_PRIORITY[a.anomalyType] -
        ANOMALY_TYPE_PRIORITY[b.anomalyType]
      );
    });

    const compactItems: CompactAnomalyItem[] = sorted
      .slice(0, MAX_ITEMS_IN_CONTEXT)
      .map((item) => ({
        productName: item.productName,
        anomalyType: item.anomalyType,
        severity: item.severity,
        recentQuantity: item.recentQuantity,
        baselineQuantity: item.baselineQuantity,
        changePercent: item.changePercent,
        movementCount: item.movementCount,
        reason: item.reason,
        suggestedAction: item.suggestedAction,
      }));

    const limitations: string[] = [];
    if (items.length > MAX_ITEMS_IN_CONTEXT) {
      limitations.push(
        `Exibindo apenas os ${MAX_ITEMS_IN_CONTEXT} itens mais relevantes de ${items.length} anomalias no total.`,
      );
    }

    return {
      generatedAt: new Date().toISOString(),
      anomalyAnalysis: { snapshot, items: compactItems },
      limitations,
    };
  }

  private assertEnabled(): void {
    if (process.env.OPENAI_AI_ASSISTANT_ENABLED === 'false') {
      throw new ServiceUnavailableException(
        'O Copiloto de consumo está temporariamente desabilitado.',
      );
    }
    if (!process.env.OPENAI_API_KEY) {
      throw new ServiceUnavailableException(
        'O Copiloto de consumo está indisponível no momento. Contate o suporte.',
      );
    }
  }

  private async callOpenAi(
    userId: string,
    clinicId: string,
    context: CopilotContext,
  ): Promise<CopilotContent> {
    const startedAt = Date.now();

    try {
      const completion = await this.openai.chat.completions.create({
        model: this.model,
        response_format: { type: 'json_object' },
        max_tokens: this.maxOutputTokens,
        temperature: 0.2,
        messages: [
          { role: 'system', content: COPILOT_SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(context) },
        ],
      });

      const raw = completion.choices[0]?.message?.content ?? '{}';
      const content = this.parseResponse(raw);

      this.logger.log(
        JSON.stringify({
          event: 'abnormal_consumption_copilot_success',
          durationMs: Date.now() - startedAt,
          model: this.model,
          createdAt: new Date().toISOString(),
        }),
      );

      // Persist — best-effort, never break the response
      try {
        await this.analysisRepository.saveSuccess({
          clinicId,
          userId,
          type: ANALYSIS_TYPE,
          content,
          model: this.model,
          generatedAt: new Date(),
          periodStart: null,
          periodEnd: null,
        });
      } catch {
        this.logger.error(
          JSON.stringify({
            event: 'abnormal_consumption_copilot_persist_failed',
            errorCode: 'PERSISTENCE_ERROR',
            createdAt: new Date().toISOString(),
          }),
        );
      }

      return content;
    } catch (err: unknown) {
      if (
        err instanceof ServiceUnavailableException ||
        err instanceof InternalServerErrorException ||
        err instanceof ForbiddenException
      ) {
        throw err;
      }

      const isRateLimit =
        typeof err === 'object' &&
        err !== null &&
        'status' in err &&
        (err as { status: number }).status === 429;

      this.logger.error(
        JSON.stringify({
          event: 'abnormal_consumption_copilot_error',
          errorCode: isRateLimit ? 'RATE_LIMIT' : 'OPENAI_ERROR',
          durationMs: Date.now() - startedAt,
          model: this.model,
          createdAt: new Date().toISOString(),
        }),
      );

      try {
        await this.analysisRepository.saveError({
          clinicId,
          userId,
          type: ANALYSIS_TYPE,
          model: this.model,
          errorMessage: isRateLimit ? 'RATE_LIMIT' : 'OPENAI_ERROR',
        });
      } catch {
        // Ignore secondary DB errors
      }

      if (isRateLimit) {
        throw new ServiceUnavailableException(
          'O Copiloto está temporariamente sobrecarregado. Tente novamente em alguns instantes.',
        );
      }

      throw new InternalServerErrorException(
        'Não foi possível gerar o resumo do Copiloto. Tente novamente.',
      );
    }
  }

  private parseResponse(raw: string): CopilotContent {
    try {
      const parsed = JSON.parse(raw) as {
        summary?: unknown;
        highlights?: unknown;
        recommendedActions?: unknown;
      };

      const summary =
        typeof parsed.summary === 'string'
          ? parsed.summary.slice(0, 800)
          : 'Não foi possível gerar um resumo. Tente novamente.';

      const highlights = Array.isArray(parsed.highlights)
        ? parsed.highlights
            .filter((h): h is string => typeof h === 'string')
            .slice(0, 4)
            .map((h) => h.slice(0, 300))
        : [];

      const recommendedActions = Array.isArray(parsed.recommendedActions)
        ? parsed.recommendedActions
            .filter((a): a is string => typeof a === 'string')
            .slice(0, 4)
            .map((a) => a.slice(0, 300))
        : [];

      return { summary, highlights, recommendedActions };
    } catch {
      this.logger.error(
        JSON.stringify({
          event: 'abnormal_consumption_copilot_parse_failed',
          errorCode: 'INVALID_JSON_RESPONSE',
          createdAt: new Date().toISOString(),
        }),
      );
      throw new InternalServerErrorException(
        'A resposta do Copiloto veio em formato inválido. Tente novamente.',
      );
    }
  }
}
