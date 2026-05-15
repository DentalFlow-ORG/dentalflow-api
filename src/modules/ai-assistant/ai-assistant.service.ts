import {
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import OpenAI from 'openai';
import type { FinanceAiContext } from './builders/finance-context.builder';
import type { InventoryAiContext } from './builders/inventory-context.builder';
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
};

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
- Considere que este é um sistema de MVP e pode haver limitações nos dados.
- Não exiba dados pessoais de pacientes — o contexto não deve conter e você não deve inferir.

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
3. "Alertas de atenção" — SOMENTE se houver riscos reais (overdueCount > 0, netProfit negativo, despesas > 90% receita) (tone: warning ou danger). Omita se não houver alertas.
4. "Oportunidades de melhoria" — baseado nos dados, não genérico (tone: neutral)
5. "Recomendações práticas" — 2-3 ações concretas (tone: neutral)
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

  constructor(
    private readonly financeContextBuilder: FinanceContextBuilder,
    private readonly inventoryContextBuilder: InventoryContextBuilder,
  ) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      this.logger.warn('OPENAI_API_KEY não configurada — assistente de IA desabilitado.');
    }
    this.openai = new OpenAI({ apiKey: apiKey ?? 'not-configured' });
    this.model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
  }

  async analyzeFinance(
    clinicId: string,
    from?: string,
    to?: string,
  ): Promise<AiAnalysisResponse> {
    this.assertConfigured();
    const context = await this.financeContextBuilder.build(clinicId, from, to);
    return this.callOpenAi(FINANCE_SYSTEM_PROMPT, context, 'finance');
  }

  async analyzeInventory(clinicId: string): Promise<AiAnalysisResponse> {
    this.assertConfigured();
    const context = await this.inventoryContextBuilder.build(clinicId);
    return this.callOpenAi(INVENTORY_SYSTEM_PROMPT, context, 'inventory');
  }

  private assertConfigured() {
    if (!process.env.OPENAI_API_KEY) {
      throw new ServiceUnavailableException(
        'O assistente de IA ainda não está configurado. Contate o suporte.',
      );
    }
  }

  private async callOpenAi(
    systemPrompt: string,
    context: FinanceAiContext | InventoryAiContext,
    domain: string,
  ): Promise<AiAnalysisResponse> {
    try {
      const completion = await this.openai.chat.completions.create({
        model: this.model,
        response_format: { type: 'json_object' },
        max_tokens: 1200,
        temperature: 0.3,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: JSON.stringify(context),
          },
        ],
      });

      const raw = completion.choices[0]?.message?.content ?? '{}';
      const parsed = this.parseResponse(raw, domain);

      return {
        ...parsed,
        generatedAt: context.generatedAt,
        model: this.model,
      };
    } catch (err: unknown) {
      if (err instanceof ServiceUnavailableException) throw err;

      const message =
        err instanceof Error ? err.message : 'Erro desconhecido';
      this.logger.error(`[AI ${domain}] OpenAI error: ${message}`);

      if (
        typeof err === 'object' &&
        err !== null &&
        'status' in err &&
        (err as { status: number }).status === 429
      ) {
        throw new ServiceUnavailableException(
          'O assistente está temporariamente sobrecarregado. Tente novamente em alguns instantes.',
        );
      }

      throw new InternalServerErrorException(
        'Não foi possível gerar a análise. Tente novamente.',
      );
    }
  }

  private parseResponse(
    raw: string,
    domain: string,
  ): Omit<AiAnalysisResponse, 'generatedAt' | 'model'> {
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
      this.logger.error(
        `[AI ${domain}] Failed to parse OpenAI response: ${raw.slice(0, 200)}`,
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
