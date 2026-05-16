import {
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AiAssistantAnalysisType } from '@prisma/client';
import OpenAI from 'openai';
import type { FinanceAiContext } from './builders/finance-context.builder';
import type { InventoryAiContext } from './builders/inventory-context.builder';
import { AiAssistantAnalysisRepository } from './ai-assistant-analysis.repository';
import { FinanceContextBuilder } from './builders/finance-context.builder';
import { InventoryContextBuilder } from './builders/inventory-context.builder';

export type AiAnalysisSection = {
  title: string;
  content: string;
  tone: 'positive' | 'warning' | 'danger' | 'neutral';
};

export type AiAnalysisResponse = {
  sections: AiAnalysisSection[];
  disclaimer: string;
  generatedAt: string;
  model: string;
  /** YYYY-MM-DD — only for FINANCE analyses */
  periodStart: string | null;
  /** YYYY-MM-DD — only for FINANCE analyses */
  periodEnd: string | null;
};

type AssistantType = 'finance' | 'inventory';

const FINANCE_SYSTEM_PROMPT = `Você é um assistente financeiro especializado em clínicas odontológicas brasileiras.

REGRAS ABSOLUTAS — siga-as sem exceção:
- Use SOMENTE os dados fornecidos no contexto JSON. Não invente valores, categorias, tendências ou situações.
- Se uma métrica não estiver no contexto, diga explicitamente que não há dados disponíveis.
- Não faça promessas de resultado nem use a palavra "garantia".
- Não forneça aconselhamento contábil, jurídico ou fiscal definitivo.
- Diferencie fato (baseado nos números) de sugestão (baseada na situação observada).
- Cite números relevantes ao discutir indicadores — não seja vago.
- Responda em português do Brasil, linguagem profissional e direta.
- Priorize clareza para o gestor da clínica.
- Você só pode usar os dados fornecidos no payload. Se uma informação não estiver disponível, diga que não há dados suficientes. Não estime lucro, risco, giro de estoque, consumo médio ou previsão sem base nos dados fornecidos.
- Não exiba dados pessoais de pacientes — o contexto não contém e você não deve inferir.

FORMATO DE RESPOSTA — JSON exato, sem markdown extra, sem texto fora do JSON:
{
  "sections": [
    {
      "title": "string (máx 60 chars)",
      "content": "string (máx 350 chars, sem markdown, sem bullets internos)",
      "tone": "positive | warning | danger | neutral"
    }
  ],
  "disclaimer": "string (máx 200 chars)"
}

SEÇÕES OBRIGATÓRIAS (nesta ordem, máx 6 seções):
1. "Resumo executivo" — 2-3 frases sobre o resultado geral (tone conforme netProfit: positive/warning/danger)
2. "Indicadores principais" — cite os números do contexto (tone: neutral)
3. "Alertas de atenção" — SOMENTE se houver riscos reais: overdueCount > 0, netProfit negativo ou despesas > 90% da receita (tone: warning ou danger). Omita se não houver alertas.
4. "Oportunidades de melhoria" — baseado nos dados, não genérico (tone: neutral)
5. "Recomendações práticas" — 2-3 ações concretas e acionáveis (tone: neutral)
6. "Limitações da análise" — SOMENTE se o array limitations não for vazio (tone: neutral)`;

const INVENTORY_SYSTEM_PROMPT = `Você é um assistente de gestão de estoque especializado em clínicas odontológicas brasileiras.

REGRAS ABSOLUTAS — siga-as sem exceção:
- Use SOMENTE os dados fornecidos no contexto JSON. Não invente produtos, categorias, consumo médio ou giro.
- Se não houver histórico de saídas/movimentações, não estime consumo médio nem giro de estoque.
- Se uma métrica não estiver no contexto, diga que não há dados disponíveis.
- Não faça promessas nem use a palavra "garantia".
- Diferencie produto zerado (status EMPTY) de abaixo do mínimo (LOW), vencido (EXPIRED) e vencendo (EXPIRING).
- Cite os nomes dos produtos críticos ao fazer recomendações — não seja genérico.
- Responda em português do Brasil, linguagem profissional e direta.
- Priorize clareza para o gestor da clínica.
- Você só pode usar os dados fornecidos no payload. Se uma informação não estiver disponível, diga que não há dados suficientes. Não estime giro de estoque, consumo médio ou previsão de reposição sem base nos dados fornecidos.
- Não exiba dados pessoais de pacientes — não há e não deve inferir.

FORMATO DE RESPOSTA — JSON exato, sem markdown extra, sem texto fora do JSON:
{
  "sections": [
    {
      "title": "string (máx 60 chars)",
      "content": "string (máx 350 chars, sem markdown, sem bullets internos)",
      "tone": "positive | warning | danger | neutral"
    }
  ],
  "disclaimer": "string (máx 200 chars)"
}

SEÇÕES OBRIGATÓRIAS (nesta ordem, máx 6 seções):
1. "Resumo executivo" — situação geral do estoque (tone conforme criticidade: positive/warning/danger)
2. "Produtos críticos" — cite os produtos zerados/vencidos por nome e categoria. Se não houver, diga explicitamente. (tone: danger se houver, positive se não houver)
3. "Categorias com atenção" — quais categorias têm mais itens críticos (tone: warning ou neutral)
4. "Risco operacional" — impacto dos produtos críticos na operação (tone: warning ou danger se houver risco)
5. "Recomendações de reposição" — ações concretas por produto/categoria (tone: neutral)
6. "Limitações da análise" — SOMENTE se o array limitations não for vazio (tone: neutral)`;

@Injectable()
export class AiAssistantService {
  private readonly logger = new Logger(AiAssistantService.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly maxOutputTokens: number;

  constructor(
    private readonly financeContextBuilder: FinanceContextBuilder,
    private readonly inventoryContextBuilder: InventoryContextBuilder,
    private readonly analysisRepository: AiAssistantAnalysisRepository,
  ) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      this.logger.warn(
        'OPENAI_API_KEY não configurada — assistente de IA desabilitado.',
      );
    }
    this.openai = new OpenAI({ apiKey: apiKey ?? 'not-configured' });
    this.model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
    this.maxOutputTokens = Number(process.env.OPENAI_AI_MAX_OUTPUT_TOKENS ?? 900);
  }

  // ─── Health / config inspection ──────────────────────────────────────────

  getConfigStatus(): {
    enabled: boolean;
    hasApiKey: boolean;
    modelConfigured: boolean;
    maxOutputTokensConfigured: boolean;
    ready: boolean;
  } {
    const enabled = process.env.OPENAI_AI_ASSISTANT_ENABLED !== 'false';
    const apiKey = process.env.OPENAI_API_KEY ?? '';
    // Format check: key must be non-empty and start with 'sk-'. Value is never logged.
    const hasApiKey = apiKey.length > 0 && apiKey.startsWith('sk-');
    const modelConfigured = !!(process.env.OPENAI_MODEL);
    const rawTokens = process.env.OPENAI_AI_MAX_OUTPUT_TOKENS;
    const maxOutputTokensConfigured =
      rawTokens !== undefined && !isNaN(Number(rawTokens)) && Number(rawTokens) > 0;
    const ready = enabled && hasApiKey;

    return { enabled, hasApiKey, modelConfigured, maxOutputTokensConfigured, ready };
  }

  async pingOpenAi(): Promise<{
    ok: boolean;
    message: string;
    durationMs: number;
    model: string;
  }> {
    const startedAt = Date.now();
    try {
      await this.openai.chat.completions.create({
        model: this.model,
        max_tokens: 10,
        temperature: 0,
        messages: [{ role: 'user', content: 'Responda apenas: OK' }],
      });
      const durationMs = Date.now() - startedAt;
      this.logger.log(
        JSON.stringify({
          event: 'health_ping',
          status: 'success',
          durationMs,
          model: this.model,
          createdAt: new Date().toISOString(),
        }),
      );
      return {
        ok: true,
        message: 'Conexão com OpenAI validada.',
        durationMs,
        model: this.model,
      };
    } catch (err: unknown) {
      const durationMs = Date.now() - startedAt;
      const isRateLimit =
        typeof err === 'object' &&
        err !== null &&
        'status' in err &&
        (err as { status: number }).status === 429;
      this.logger.error(
        JSON.stringify({
          event: 'health_ping',
          status: 'error',
          errorCode: isRateLimit ? 'RATE_LIMIT' : 'OPENAI_ERROR',
          durationMs,
          model: this.model,
          createdAt: new Date().toISOString(),
        }),
      );
      return {
        ok: false,
        message: isRateLimit
          ? 'Rate limit atingido. Tente novamente em alguns instantes.'
          : 'Falha na conexão com OpenAI. Verifique a configuração e a chave.',
        durationMs,
        model: this.model,
      };
    }
  }

  // ─── Persistence: load saved analyses ────────────────────────────────────

  async getLatestFinance(clinicId: string): Promise<AiAnalysisResponse | null> {
    const record = await this.analysisRepository.findLatest(
      clinicId,
      AiAssistantAnalysisType.FINANCE,
    );
    return record ? this.mapAnalysisToResponse(record) : null;
  }

  async getLatestInventory(clinicId: string): Promise<AiAnalysisResponse | null> {
    const record = await this.analysisRepository.findLatest(
      clinicId,
      AiAssistantAnalysisType.INVENTORY,
    );
    return record ? this.mapAnalysisToResponse(record) : null;
  }

  private mapAnalysisToResponse(record: {
    content: unknown;
    model: string | null;
    generatedAt: Date;
    periodStart: Date | null;
    periodEnd: Date | null;
  }): AiAnalysisResponse {
    const content = record.content as {
      sections: AiAnalysisSection[];
      disclaimer: string;
    };
    return {
      sections: content.sections,
      disclaimer: content.disclaimer,
      generatedAt: record.generatedAt.toISOString(),
      model: record.model ?? 'unknown',
      periodStart: record.periodStart
        ? record.periodStart.toISOString().slice(0, 10)
        : null,
      periodEnd: record.periodEnd
        ? record.periodEnd.toISOString().slice(0, 10)
        : null,
    };
  }

  // ─── Analysis endpoints ───────────────────────────────────────────────────

  async analyzeFinance(
    userId: string,
    clinicId: string,
    from?: string,
    to?: string,
  ): Promise<AiAnalysisResponse> {
    this.assertEnabled();
    const context = await this.financeContextBuilder.build(clinicId, from, to);
    return this.callOpenAi(userId, clinicId, FINANCE_SYSTEM_PROMPT, context, 'finance');
  }

  async analyzeInventory(
    userId: string,
    clinicId: string,
  ): Promise<AiAnalysisResponse> {
    this.assertEnabled();
    const context = await this.inventoryContextBuilder.build(clinicId);
    return this.callOpenAi(userId, clinicId, INVENTORY_SYSTEM_PROMPT, context, 'inventory');
  }

  private assertEnabled() {
    const enabled = process.env.OPENAI_AI_ASSISTANT_ENABLED;
    if (enabled === 'false') {
      throw new ServiceUnavailableException(
        'O assistente IA está desabilitado no momento.',
      );
    }
    if (!process.env.OPENAI_API_KEY) {
      throw new ServiceUnavailableException(
        'O assistente IA indisponível no momento. Contate o suporte.',
      );
    }
  }

  private async callOpenAi(
    userId: string,
    clinicId: string,
    systemPrompt: string,
    context: FinanceAiContext | InventoryAiContext,
    assistantType: AssistantType,
  ): Promise<AiAnalysisResponse> {
    const startedAt = Date.now();

    try {
      const completion = await this.openai.chat.completions.create({
        model: this.model,
        response_format: { type: 'json_object' },
        max_tokens: this.maxOutputTokens,
        temperature: 0.3,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify(context) },
        ],
      });

      const raw = completion.choices[0]?.message?.content ?? '{}';
      const parsed = this.parseResponse(raw, assistantType);

      this.logEvent({
        userId,
        clinicId,
        assistantType,
        status: 'success',
        durationMs: Date.now() - startedAt,
        model: this.model,
      });

      const periodStart =
        assistantType === 'finance' && 'period' in context
          ? new Date((context as FinanceAiContext).period.from)
          : null;
      const periodEnd =
        assistantType === 'finance' && 'period' in context
          ? new Date((context as FinanceAiContext).period.to)
          : null;

      // Persist — best-effort: never let a DB failure break the analysis response
      try {
        await this.analysisRepository.saveSuccess({
          clinicId,
          userId,
          type:
            assistantType === 'finance'
              ? AiAssistantAnalysisType.FINANCE
              : AiAssistantAnalysisType.INVENTORY,
          content: { sections: parsed.sections, disclaimer: parsed.disclaimer },
          model: this.model,
          generatedAt: new Date(context.generatedAt),
          periodStart,
          periodEnd,
        });
      } catch (dbErr: unknown) {
        this.logger.error(
          `[AI ${assistantType}] Failed to persist analysis: ${dbErr instanceof Error ? dbErr.message : 'unknown'}`,
        );
      }

      return {
        ...parsed,
        generatedAt: context.generatedAt,
        model: this.model,
        periodStart: periodStart?.toISOString().slice(0, 10) ?? null,
        periodEnd: periodEnd?.toISOString().slice(0, 10) ?? null,
      };
    } catch (err: unknown) {
      if (
        err instanceof ServiceUnavailableException ||
        err instanceof InternalServerErrorException
      ) {
        throw err;
      }

      const isRateLimit =
        typeof err === 'object' &&
        err !== null &&
        'status' in err &&
        (err as { status: number }).status === 429;

      const errorCode = isRateLimit ? 'RATE_LIMIT' : 'OPENAI_ERROR';

      this.logEvent({
        userId,
        clinicId,
        assistantType,
        status: 'error',
        errorCode,
        durationMs: Date.now() - startedAt,
        model: this.model,
      });

      // Persist error record — best-effort, sanitized
      try {
        await this.analysisRepository.saveError({
          clinicId,
          userId,
          type:
            assistantType === 'finance'
              ? AiAssistantAnalysisType.FINANCE
              : AiAssistantAnalysisType.INVENTORY,
          model: this.model,
          errorMessage: isRateLimit ? 'RATE_LIMIT' : 'OPENAI_ERROR',
        });
      } catch {
        // Ignore secondary DB errors
      }

      if (isRateLimit) {
        throw new ServiceUnavailableException(
          'O assistente está temporariamente sobrecarregado. Tente novamente em alguns instantes.',
        );
      }

      throw new InternalServerErrorException(
        'Não foi possível gerar a análise. Tente novamente.',
      );
    }
  }

  private logEvent(event: {
    userId: string;
    clinicId: string;
    assistantType: AssistantType;
    status: 'success' | 'error';
    errorCode?: string;
    durationMs: number;
    model: string;
  }) {
    // Structured log — never includes payload, response content or API key
    const entry = {
      ...event,
      createdAt: new Date().toISOString(),
    };

    if (event.status === 'success') {
      this.logger.log(JSON.stringify(entry));
    } else {
      this.logger.error(JSON.stringify(entry));
    }
  }

  private parseResponse(
    raw: string,
    assistantType: AssistantType,
  ): Omit<AiAnalysisResponse, 'generatedAt' | 'model' | 'periodStart' | 'periodEnd'> {
    try {
      const parsed = JSON.parse(raw) as {
        sections?: unknown[];
        disclaimer?: string;
      };

      const sections = Array.isArray(parsed.sections)
        ? parsed.sections
            .filter(
              (s): s is { title: string; content: string; tone: string } =>
                typeof s === 'object' &&
                s !== null &&
                typeof (s as Record<string, unknown>).title === 'string' &&
                typeof (s as Record<string, unknown>).content === 'string',
            )
            .slice(0, 6)
            .map((s) => ({
              title: String(s.title).slice(0, 80),
              content: String(s.content).slice(0, 500),
              tone: this.sanitizeTone(s.tone),
            }))
        : [];

      const disclaimer =
        typeof parsed.disclaimer === 'string'
          ? parsed.disclaimer.slice(0, 300)
          : 'Análise gerada com base nos dados disponíveis no sistema. Revise antes de tomar decisões críticas.';

      return { sections, disclaimer };
    } catch {
      // Log only type/domain, never the raw content in full
      this.logger.error(
        `[AI ${assistantType}] Failed to parse OpenAI response (first 100 chars): ${raw.slice(0, 100)}`,
      );
      throw new InternalServerErrorException(
        'A resposta da IA veio em formato inválido. Tente novamente.',
      );
    }
  }

  private sanitizeTone(
    value: unknown,
  ): 'positive' | 'warning' | 'danger' | 'neutral' {
    if (
      value === 'positive' ||
      value === 'warning' ||
      value === 'danger' ||
      value === 'neutral'
    ) {
      return value;
    }
    return 'neutral';
  }
}
