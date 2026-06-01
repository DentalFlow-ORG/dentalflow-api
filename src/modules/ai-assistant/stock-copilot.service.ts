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
  PurchaseListItem,
  PurchaseListResult,
} from '../stock/stock-purchase-list.service';
import { StockPurchaseListService } from '../stock/stock-purchase-list.service';
import { AiAssistantAnalysisRepository } from './ai-assistant-analysis.repository';
import { AiQuotaService } from './ai-quota.service';
import { getBrazilDayRange } from '../../common/utils/brazil-timezone';

// ── Response types ────────────────────────────────────────────────────────────

export type CopilotSummaryResult = {
  summary: string;
  highlights: string[];
  recommendedActions: string[];
  generatedAt: string;
  cached: boolean;
  source: 'AI' | 'CACHE';
  purchaseListSnapshot: PurchaseListSnapshot;
};

type PurchaseListSnapshot = {
  totalItems: number;
  criticalItems: number;
  highPriorityItems: number;
  mediumPriorityItems: number;
  totalEstimatedCostCents: number;
};

type CopilotContent = {
  summary: string;
  highlights: string[];
  recommendedActions: string[];
};

// ── AI context types ──────────────────────────────────────────────────────────

type CompactPurchaseItem = {
  productName: string;
  priority: string;
  currentQuantity: number;
  minQuantity: number;
  suggestedPurchaseQuantity: number;
  estimatedCostCents?: number;
  reason: string;
};

type CopilotContext = {
  generatedAt: string;
  currency: 'BRL';
  purchaseList: {
    summary: PurchaseListSnapshot;
    items: CompactPurchaseItem[];
  };
  limitations: string[];
};

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_ITEMS_IN_CONTEXT = 10;

const COPILOT_SYSTEM_PROMPT = `Você é um assistente de gestão de compras especializado em clínicas odontológicas brasileiras.

REGRAS ABSOLUTAS — siga-as sem exceção:
- Use SOMENTE os dados fornecidos no contexto JSON. Não invente produtos, quantidades, preços ou situações.
- Se uma métrica não estiver no contexto, diga explicitamente que não há dados disponíveis.
- Não forneça aconselhamento médico ou odontológico.
- Não mencione pacientes, procedimentos, agendamentos ou dados clínicos.
- Não invente fornecedores, nomes de clínicas ou dados não fornecidos.
- Responda em português do Brasil, linguagem profissional e direta.
- Priorize os itens críticos ao fazer recomendações.
- Mencione custo estimado somente se disponível nos dados.
- Se o array limitations não for vazio, reconheça a limitação de dados.

FORMATO DE RESPOSTA — JSON exato, sem markdown extra, sem texto fora do JSON:
{
  "summary": "string (2 a 4 frases sobre a situação atual da lista de compra)",
  "highlights": ["string", "string"],
  "recommendedActions": ["string", "string"]
}

REGRAS DE CONTEÚDO:
- summary: 2 a 4 frases, situação objetiva e acionável
- highlights: 2 a 4 pontos de atenção concretos, cite produtos ou números quando relevante
- recommendedActions: 2 a 4 ações práticas e específicas
- Tom: profissional, calmo, orientado a negócio, sem exageros`;

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class StockCopilotService {
  private readonly logger = new Logger(StockCopilotService.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly maxOutputTokens: number;

  constructor(
    private readonly purchaseListService: StockPurchaseListService,
    private readonly analysisRepository: AiAssistantAnalysisRepository,
    private readonly quotaService: AiQuotaService,
  ) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      this.logger.warn('OPENAI_API_KEY not configured — stock copilot disabled.');
    }
    this.openai = new OpenAI({ apiKey: apiKey ?? 'not-configured' });
    this.model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
    this.maxOutputTokens = Number(process.env.OPENAI_AI_MAX_OUTPUT_TOKENS ?? 600);
  }

  async getCopilotSummary(
    userId: string,
    clinicId: string,
    forceRefresh: boolean,
  ): Promise<CopilotSummaryResult | null> {
    // 1. Purchase list is always cheap (deterministic, no AI)
    const purchaseList = await this.purchaseListService.getPurchaseList(clinicId);
    const snapshot = purchaseList.summary;

    // 2. Empty purchase list — nothing to analyze
    if (snapshot.totalItems === 0) return null;

    // 3. Plan allowed check — applies to ALL calls, including cache hits
    const quota = await this.quotaService.getQuota(
      clinicId,
      AiAssistantAnalysisType.STOCK_COPILOT,
    );
    if (!quota.allowed) {
      throw new ForbiddenException(
        'O Copiloto de estoque está disponível nos planos Professional e Premium.',
      );
    }

    // 4. Cache path — only if not forcing refresh
    if (!forceRefresh) {
      const cached = await this.findTodayCache(clinicId);
      if (cached) {
        const content = cached.content as CopilotContent;
        return {
          ...content,
          generatedAt: cached.generatedAt.toISOString(),
          cached: true,
          source: 'CACHE',
          purchaseListSnapshot: snapshot,
        };
      }
      // No cache, no AI auto-call — caller decides what to do next
      return null;
    }

    // 5. Fresh AI call — check remaining quota
    if (quota.remaining <= 0) {
      throw new HttpException(
        quota.blockedReason ??
          'Limite mensal de análises de IA atingido. Tente novamente no próximo mês.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    this.assertEnabled();

    // 6. Build compact context and call AI
    const context = this.buildContext(purchaseList, snapshot);
    const content = await this.callOpenAi(userId, clinicId, context);

    return {
      ...content,
      generatedAt: new Date().toISOString(),
      cached: false,
      source: 'AI',
      purchaseListSnapshot: snapshot,
    };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async findTodayCache(clinicId: string) {
    const record = await this.analysisRepository.findLatest(
      clinicId,
      AiAssistantAnalysisType.STOCK_COPILOT,
    );
    if (!record) return null;
    // generatedAt is a UTC timestamp — check against Brazil day start so a cache
    // generated at 23:00 Brazil is not evicted at 00:01 UTC next day.
    const { start: brazilDayStart } = getBrazilDayRange();
    return record.generatedAt >= brazilDayStart ? record : null;
  }

  private buildContext(
    purchaseList: PurchaseListResult,
    snapshot: PurchaseListSnapshot,
  ): CopilotContext {
    const items: CompactPurchaseItem[] = purchaseList.items
      .slice(0, MAX_ITEMS_IN_CONTEXT)
      .map((item: PurchaseListItem) => {
        const compact: CompactPurchaseItem = {
          productName: item.productName,
          priority: item.priority,
          currentQuantity: item.currentQuantity,
          minQuantity: item.minQuantity,
          suggestedPurchaseQuantity: item.suggestedPurchaseQuantity,
          reason: item.reason,
        };
        if (item.estimatedCostCents !== null) {
          compact.estimatedCostCents = item.estimatedCostCents;
        }
        return compact;
      });

    const limitations: string[] = [];
    const withoutPrice = purchaseList.items.filter(
      (i) => i.estimatedCostCents === null,
    ).length;
    if (withoutPrice > 0) {
      limitations.push(
        `${withoutPrice} item(ns) sem preço de compra cadastrado.`,
      );
    }
    if (purchaseList.items.length > MAX_ITEMS_IN_CONTEXT) {
      limitations.push(
        `Exibindo apenas os ${MAX_ITEMS_IN_CONTEXT} itens mais prioritários de ${purchaseList.items.length} no total.`,
      );
    }

    return {
      generatedAt: new Date().toISOString(),
      currency: 'BRL',
      purchaseList: { summary: snapshot, items },
      limitations,
    };
  }

  private assertEnabled(): void {
    if (process.env.OPENAI_AI_ASSISTANT_ENABLED === 'false') {
      throw new ServiceUnavailableException(
        'O Copiloto de estoque está temporariamente desabilitado.',
      );
    }
    if (!process.env.OPENAI_API_KEY) {
      throw new ServiceUnavailableException(
        'O Copiloto de estoque está indisponível no momento. Contate o suporte.',
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
          event: 'stock_copilot_success',
          durationMs: Date.now() - startedAt,
          model: this.model,
          createdAt: new Date().toISOString(),
        }),
      );

      // Persist — best-effort, never let a DB failure break the response
      try {
        await this.analysisRepository.saveSuccess({
          clinicId,
          userId,
          type: AiAssistantAnalysisType.STOCK_COPILOT,
          content,
          model: this.model,
          generatedAt: new Date(),
          periodStart: null,
          periodEnd: null,
        });
      } catch {
        this.logger.error(
          JSON.stringify({
            event: 'stock_copilot_persist_failed',
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
          event: 'stock_copilot_error',
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
          type: AiAssistantAnalysisType.STOCK_COPILOT,
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
          event: 'stock_copilot_parse_failed',
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
