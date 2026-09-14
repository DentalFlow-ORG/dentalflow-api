import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AiAssistantAnalysisStatus,
  AiAssistantAnalysisType,
  FinancialTransactionStatus,
  FinancialTransactionType,
} from '@prisma/client';
import OpenAI from 'openai';
import { PrismaService } from '../../prisma/prisma.service';
import { AiAssistantAnalysisRepository } from './ai-assistant-analysis.repository';
import { AiQuotaService } from './ai-quota.service';
import { MonthlyFinanceDiagnosisDto } from './dto/monthly-finance-diagnosis.dto';

// ── Response types ─────────────────────────────────────────────────────────────

export type DiagnosisFinancialHealth = 'HEALTHY' | 'WARNING' | 'CRITICAL';
export type DiagnosisAlertType =
  | 'LOW_MARGIN'
  | 'HIGH_EXPENSE_CATEGORY'
  | 'UNCATEGORIZED_EXPENSES'
  | 'NEGATIVE_RESULT'
  | 'LOW_DATA';

export type DiagnosisAlert = {
  type: DiagnosisAlertType;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  message: string;
};

export type TopExpenseCategory = {
  categoryName: string;
  amountCents: number;
  percentageOfExpenses: number;
};

export type WeeklyCashflow = {
  weekLabel: string;
  incomeCents: number;
  expenseCents: number;
  netCents: number;
};

export type FinanceSnapshot = {
  month: string;
  revenueCents: number;
  expenseCents: number;
  profitCents: number;
  profitMarginPercent: number | null;
  transactionCount: number;
  incomeTransactionCount: number;
  expenseTransactionCount: number;
  uncategorizedExpenseCount: number;
  topExpenseCategories: TopExpenseCategory[];
  cashflowByWeek: WeeklyCashflow[];
  alerts: DiagnosisAlert[];
};

export type MonthlyFinanceDiagnosisResult = {
  summary: string;
  financialHealth: DiagnosisFinancialHealth;
  highlights: string[];
  risks: string[];
  recommendedActions: string[];
  generatedAt: string;
  cached: boolean;
  source: 'AI' | 'CACHE';
  financeSnapshot: FinanceSnapshot;
};

// ── AI content stored in the cache record ─────────────────────────────────────

type DiagnosisContent = {
  month: string;
  summary: string;
  financialHealth: DiagnosisFinancialHealth;
  highlights: string[];
  risks: string[];
  recommendedActions: string[];
  financeSnapshot: FinanceSnapshot;
};

// ── AI context shape (safe, no patient/clinical data) ─────────────────────────

type DiagnosisAiContext = {
  month: string;
  revenueCents: number;
  expenseCents: number;
  profitCents: number;
  profitMarginPercent: number | null;
  incomeTransactionCount: number;
  expenseTransactionCount: number;
  uncategorizedExpenseCount: number;
  topExpenseCategories: TopExpenseCategory[];
  cashflowByWeek: WeeklyCashflow[];
  alerts: DiagnosisAlert[];
};

// ── Constants ──────────────────────────────────────────────────────────────────

const ANALYSIS_TYPE = AiAssistantAnalysisType.MONTHLY_FINANCE_DIAGNOSIS;
const AI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
const MAX_AI_TOKENS = parseInt(
  process.env.OPENAI_AI_MAX_OUTPUT_TOKENS ?? '600',
  10,
);
const MIN_TRANSACTIONS_FOR_AI = 1;

const SYSTEM_PROMPT = `Você é um consultor financeiro operacional para clínicas odontológicas brasileiras.

REGRAS ABSOLUTAS — siga-as sem exceção:
1. Retorne APENAS JSON válido no formato especificado. Sem texto fora do JSON.
2. Use SOMENTE os dados fornecidos no contexto. Não invente receitas, despesas, pacientes, procedimentos ou categorias.
3. Responda em português do Brasil, com linguagem profissional, calma e orientada a negócio.
4. summary: 2 a 4 frases descrevendo a situação financeira do mês de forma objetiva.
5. highlights: 2 a 4 pontos positivos observados nos dados. Se não houver pontos positivos claros, indique o que está sob controle.
6. risks: 1 a 4 pontos de atenção com potencial impacto financeiro. Evite alarme excessivo.
7. recommendedActions: 2 a 4 ações concretas, práticas e operacionais baseadas nos dados.
8. financialHealth: avalie como "HEALTHY" se margem >= 20% e sem alertas críticos; "WARNING" se margem baixa, resultado negativo leve ou concentração de gastos; "CRITICAL" se resultado muito negativo ou alertas críticos presentes.
9. Não forneça aconselhamento jurídico, contábil ou tributário.
10. Não afirme ser um contador ou especialista jurídico.
11. Deixe claro que este é um diagnóstico operacional baseado nos lançamentos registrados no sistema.
12. Se houver despesas sem categoria (uncategorizedExpenseCount > 0), mencione que a qualidade do diagnóstico depende da categorização correta das despesas.
13. Não exagere a gravidade — use tom calmo, construtivo e orientado a soluções.
14. Se o contexto incluir alertas, mencione-os de forma pertinente e propositiva.

Formato de resposta JSON esperado:
{
  "summary": "string",
  "financialHealth": "HEALTHY" | "WARNING" | "CRITICAL",
  "highlights": ["string", ...],
  "risks": ["string", ...],
  "recommendedActions": ["string", ...]
}`;

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class MonthlyFinanceDiagnosisService {
  private readonly logger = new Logger(MonthlyFinanceDiagnosisService.name);
  openai: OpenAI | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly analysisRepository: AiAssistantAnalysisRepository,
    private readonly quotaService: AiQuotaService,
  ) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      this.logger.warn(
        'OPENAI_API_KEY not configured — monthly finance diagnosis AI disabled.',
      );
    } else {
      this.openai = new OpenAI({ apiKey });
    }
  }

  async diagnose(
    userId: string,
    clinicId: string,
    dto: MonthlyFinanceDiagnosisDto,
  ): Promise<MonthlyFinanceDiagnosisResult> {
    const { month, forceRefresh = false } = dto;
    const { firstDay, nextMonth } = this.monthBounds(month);

    // Build deterministic finance snapshot
    const snapshot = await this.buildFinanceSnapshot(
      clinicId,
      month,
      firstDay,
      nextMonth,
    );

    // Check cache first (skip if forceRefresh)
    if (!forceRefresh) {
      const cached = await this.findCache(clinicId, month);
      if (cached) {
        const content = cached.content as DiagnosisContent;
        return this.buildResult(content, cached.generatedAt, true, snapshot);
      }
    }

    // Return deterministic LOW_DATA response without AI call
    if (snapshot.transactionCount < MIN_TRANSACTIONS_FOR_AI) {
      return this.buildLowDataResult(snapshot);
    }

    // Quota gate (only before actual AI call)
    const quota = await this.quotaService.getQuota(clinicId, ANALYSIS_TYPE);
    if (!quota.allowed) {
      throw new ForbiddenException(
        'O diagnóstico financeiro mensal não está disponível no seu plano atual.',
      );
    }
    if (quota.remaining <= 0) {
      throw new HttpException(
        'Limite mensal de diagnósticos financeiros atingido. Tente novamente no próximo mês.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return this.callAi(userId, clinicId, month, snapshot, firstDay, nextMonth);
  }

  // ── Finance snapshot ───────────────────────────────────────────────────────

  async buildFinanceSnapshot(
    clinicId: string,
    month: string,
    firstDay: Date,
    nextMonth: Date,
  ): Promise<FinanceSnapshot> {
    const transactions = await this.prisma.financialTransaction.findMany({
      where: {
        clinicId,
        status: { not: FinancialTransactionStatus.CANCELED },
        transactionDate: { gte: firstDay, lt: nextMonth },
      },
      include: { category: true },
      orderBy: { transactionDate: 'asc' },
    });

    const income = transactions.filter(
      (t) => t.type === FinancialTransactionType.INCOME,
    );
    const expenses = transactions.filter(
      (t) => t.type === FinancialTransactionType.EXPENSE,
    );

    const revenueCents = this.sumCents(income);
    const expenseCents = this.sumCents(expenses);
    const profitCents = revenueCents - expenseCents;
    const profitMarginPercent =
      revenueCents > 0
        ? Math.round((profitCents / revenueCents) * 10000) / 100
        : null;

    const uncategorizedExpenseCount = expenses.filter(
      (t) =>
        t.category.isDefault &&
        t.category.name.toLowerCase().includes('manuais'),
    ).length;

    const topExpenseCategories = this.buildTopExpenseCategories(
      expenses,
      expenseCents,
    );
    const cashflowByWeek = this.buildCashflowByWeek(
      transactions,
      firstDay,
      nextMonth,
    );
    const alerts = this.buildAlerts(
      profitCents,
      profitMarginPercent,
      topExpenseCategories,
      uncategorizedExpenseCount,
      transactions.length,
    );

    return {
      month,
      revenueCents,
      expenseCents,
      profitCents,
      profitMarginPercent,
      transactionCount: transactions.length,
      incomeTransactionCount: income.length,
      expenseTransactionCount: expenses.length,
      uncategorizedExpenseCount,
      topExpenseCategories,
      cashflowByWeek,
      alerts,
    };
  }

  private buildTopExpenseCategories(
    expenses: { amount: object; category: { name: string } }[],
    totalExpenseCents: number,
  ): TopExpenseCategory[] {
    const grouped = new Map<string, number>();
    for (const t of expenses) {
      const name = t.category.name;
      grouped.set(name, (grouped.get(name) ?? 0) + this.toCents(t.amount));
    }
    return [...grouped.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([categoryName, amountCents]) => ({
        categoryName,
        amountCents,
        percentageOfExpenses:
          totalExpenseCents > 0
            ? Math.round((amountCents / totalExpenseCents) * 10000) / 100
            : 0,
      }));
  }

  private buildCashflowByWeek(
    transactions: {
      type: FinancialTransactionType;
      amount: object;
      transactionDate: Date;
    }[],
    firstDay: Date,
    nextMonth: Date,
  ): WeeklyCashflow[] {
    const weeks: WeeklyCashflow[] = [
      { weekLabel: 'Semana 1', incomeCents: 0, expenseCents: 0, netCents: 0 },
      { weekLabel: 'Semana 2', incomeCents: 0, expenseCents: 0, netCents: 0 },
      { weekLabel: 'Semana 3', incomeCents: 0, expenseCents: 0, netCents: 0 },
      { weekLabel: 'Semana 4', incomeCents: 0, expenseCents: 0, netCents: 0 },
    ];

    for (const t of transactions) {
      const day = t.transactionDate.getUTCDate();
      const weekIdx = day <= 7 ? 0 : day <= 14 ? 1 : day <= 21 ? 2 : 3;
      const cents = this.toCents(t.amount);
      if (t.type === FinancialTransactionType.INCOME) {
        weeks[weekIdx].incomeCents += cents;
      } else {
        weeks[weekIdx].expenseCents += cents;
      }
    }

    for (const w of weeks) {
      w.netCents = w.incomeCents - w.expenseCents;
    }

    // Remove trailing empty weeks for months with fewer days
    const lastDay = new Date(nextMonth.getTime() - 1).getUTCDate();
    if (lastDay <= 21) return weeks.slice(0, 3);
    return weeks;
  }

  private buildAlerts(
    profitCents: number,
    profitMarginPercent: number | null,
    topCategories: TopExpenseCategory[],
    uncategorizedExpenseCount: number,
    transactionCount: number,
  ): DiagnosisAlert[] {
    const alerts: DiagnosisAlert[] = [];

    if (transactionCount === 0) {
      alerts.push({
        type: 'LOW_DATA',
        severity: 'HIGH',
        message: 'Não há lançamentos financeiros registrados neste mês.',
      });
      return alerts;
    }

    if (profitCents < 0) {
      alerts.push({
        type: 'NEGATIVE_RESULT',
        severity: 'HIGH',
        message:
          'O resultado do mês é negativo — as despesas superaram as receitas.',
      });
    } else if (profitMarginPercent !== null && profitMarginPercent < 20) {
      alerts.push({
        type: 'LOW_MARGIN',
        severity: 'MEDIUM',
        message: `Margem de lucro de ${profitMarginPercent.toFixed(1)}% está abaixo de 20%.`,
      });
    }

    const dominantCategory = topCategories.find(
      (c) => c.percentageOfExpenses > 60,
    );
    if (dominantCategory) {
      alerts.push({
        type: 'HIGH_EXPENSE_CATEGORY',
        severity: 'MEDIUM',
        message: `A categoria "${dominantCategory.categoryName}" representa ${dominantCategory.percentageOfExpenses.toFixed(1)}% das despesas.`,
      });
    }

    if (uncategorizedExpenseCount > 0) {
      alerts.push({
        type: 'UNCATEGORIZED_EXPENSES',
        severity: 'LOW',
        message: `${uncategorizedExpenseCount} despesa(s) sem categoria específica podem reduzir a precisão do diagnóstico.`,
      });
    }

    return alerts;
  }

  // ── Cache ──────────────────────────────────────────────────────────────────

  private async findCache(clinicId: string, month: string) {
    return this.prisma.aiAssistantAnalysis.findFirst({
      where: {
        clinicId,
        type: ANALYSIS_TYPE,
        status: AiAssistantAnalysisStatus.SUCCESS,
        content: { path: ['month'], equals: month },
      },
      orderBy: { generatedAt: 'desc' },
    });
  }

  // ── AI call ────────────────────────────────────────────────────────────────

  private async callAi(
    userId: string,
    clinicId: string,
    month: string,
    snapshot: FinanceSnapshot,
    firstDay: Date,
    nextMonth: Date,
  ): Promise<MonthlyFinanceDiagnosisResult> {
    this.assertAiEnabled();

    const aiContext: DiagnosisAiContext = {
      month: snapshot.month,
      revenueCents: snapshot.revenueCents,
      expenseCents: snapshot.expenseCents,
      profitCents: snapshot.profitCents,
      profitMarginPercent: snapshot.profitMarginPercent,
      incomeTransactionCount: snapshot.incomeTransactionCount,
      expenseTransactionCount: snapshot.expenseTransactionCount,
      uncategorizedExpenseCount: snapshot.uncategorizedExpenseCount,
      topExpenseCategories: snapshot.topExpenseCategories,
      cashflowByWeek: snapshot.cashflowByWeek,
      alerts: snapshot.alerts,
    };

    const start = Date.now();
    let aiSummary = '';
    let aiHealth: DiagnosisFinancialHealth = 'WARNING';
    let aiHighlights: string[] = [];
    let aiRisks: string[] = [];
    let aiActions: string[] = [];

    try {
      const response = await this.openai!.chat.completions.create({
        model: AI_MODEL,
        temperature: 0.3,
        max_tokens: MAX_AI_TOKENS,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(aiContext) },
        ],
      });

      const raw = response.choices[0]?.message?.content ?? '{}';
      const parsed = JSON.parse(raw) as {
        summary?: string;
        financialHealth?: string;
        highlights?: string[];
        risks?: string[];
        recommendedActions?: string[];
      };

      aiSummary = typeof parsed.summary === 'string' ? parsed.summary : '';
      aiHealth = this.parseHealth(parsed.financialHealth);
      aiHighlights = Array.isArray(parsed.highlights)
        ? parsed.highlights.filter(Boolean)
        : [];
      aiRisks = Array.isArray(parsed.risks) ? parsed.risks.filter(Boolean) : [];
      aiActions = Array.isArray(parsed.recommendedActions)
        ? parsed.recommendedActions.filter(Boolean)
        : [];

      this.logger.log(
        JSON.stringify({
          event: 'monthly_finance_diagnosis_success',
          durationMs: Date.now() - start,
          model: AI_MODEL,
          month,
          createdAt: new Date().toISOString(),
        }),
      );
    } catch (err: unknown) {
      const durationMs = Date.now() - start;
      const isRateLimit =
        typeof err === 'object' &&
        err !== null &&
        (err as { status?: number }).status === 429;

      this.logger.error(
        JSON.stringify({
          event: 'monthly_finance_diagnosis_error',
          errorCode: isRateLimit ? 'RATE_LIMIT' : 'OPENAI_ERROR',
          durationMs,
          model: AI_MODEL,
          month,
          createdAt: new Date().toISOString(),
        }),
      );

      this.analysisRepository
        .saveError({
          clinicId,
          userId,
          type: ANALYSIS_TYPE,
          model: AI_MODEL,
          errorMessage: err instanceof Error ? err.message : 'Unknown error',
        })
        .catch(() => undefined);

      if (isRateLimit) {
        throw new ServiceUnavailableException(
          'O serviço de diagnóstico está temporariamente indisponível. Tente novamente em instantes.',
        );
      }
      throw new InternalServerErrorException(
        'Não foi possível gerar o diagnóstico financeiro. Tente novamente.',
      );
    }

    const generatedAt = new Date();
    const content: DiagnosisContent = {
      month,
      summary: aiSummary,
      financialHealth: aiHealth,
      highlights: aiHighlights,
      risks: aiRisks,
      recommendedActions: aiActions,
      financeSnapshot: snapshot,
    };

    this.analysisRepository
      .saveSuccess({
        clinicId,
        userId,
        type: ANALYSIS_TYPE,
        content,
        model: AI_MODEL,
        generatedAt,
        periodStart: firstDay,
        periodEnd: new Date(nextMonth.getTime() - 1),
      })
      .catch(() => undefined);

    return {
      summary: aiSummary,
      financialHealth: aiHealth,
      highlights: aiHighlights,
      risks: aiRisks,
      recommendedActions: aiActions,
      generatedAt: generatedAt.toISOString(),
      cached: false,
      source: 'AI',
      financeSnapshot: snapshot,
    };
  }

  // ── Low data (deterministic, no AI) ───────────────────────────────────────

  private buildLowDataResult(
    snapshot: FinanceSnapshot,
  ): MonthlyFinanceDiagnosisResult {
    return {
      summary:
        'Ainda não há lançamentos financeiros suficientes para gerar um diagnóstico confiável deste mês. Registre as receitas e despesas do período para obter uma análise mais completa.',
      financialHealth: 'WARNING',
      highlights: [],
      risks: [],
      recommendedActions: [
        'Registre as receitas recebidas no mês.',
        'Registre as despesas pagas no mês.',
      ],
      generatedAt: new Date().toISOString(),
      cached: false,
      source: 'AI',
      financeSnapshot: snapshot,
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private buildResult(
    content: DiagnosisContent,
    generatedAt: Date,
    cached: boolean,
    currentSnapshot: FinanceSnapshot,
  ): MonthlyFinanceDiagnosisResult {
    return {
      summary: content.summary,
      financialHealth: content.financialHealth,
      highlights: content.highlights,
      risks: content.risks,
      recommendedActions: content.recommendedActions,
      generatedAt: generatedAt.toISOString(),
      cached,
      source: 'CACHE',
      financeSnapshot: currentSnapshot,
    };
  }

  monthBounds(month: string): { firstDay: Date; nextMonth: Date } {
    const [year, mon] = month.split('-').map(Number);
    const firstDay = new Date(Date.UTC(year, mon - 1, 1));
    const nextMonth = new Date(Date.UTC(year, mon, 1));
    return { firstDay, nextMonth };
  }

  private sumCents(transactions: { amount: object }[]): number {
    return transactions.reduce((sum, t) => sum + this.toCents(t.amount), 0);
  }

  private toCents(amount: object): number {
    return Math.round(Number(amount) * 100);
  }

  private parseHealth(raw: string | undefined): DiagnosisFinancialHealth {
    if (raw === 'HEALTHY' || raw === 'WARNING' || raw === 'CRITICAL')
      return raw;
    return 'WARNING';
  }

  private assertAiEnabled() {
    if (!this.openai) {
      throw new ServiceUnavailableException(
        'O diagnóstico financeiro inteligente está indisponível no momento. Contate o suporte.',
      );
    }
  }
}
