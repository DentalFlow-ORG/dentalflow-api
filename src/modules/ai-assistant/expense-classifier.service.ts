import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AiAssistantAnalysisStatus,
  AiAssistantAnalysisType,
  FinancialTransactionType,
} from '@prisma/client';
import OpenAI from 'openai';
import { PrismaService } from '../../prisma/prisma.service';
import { AiAssistantAnalysisRepository } from './ai-assistant-analysis.repository';
import { AiQuotaService } from './ai-quota.service';
import {
  ApplySuggestedCategoryDto,
  BatchClassifyExpenseDto,
  ClassifyExpenseDto,
} from './dto/classify-expense.dto';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ClassificationSource = 'RULE' | 'AI' | 'CACHE' | 'NO_MATCH';

export type ClassificationResult = {
  transactionId: string;
  suggestedCategoryId: string | null;
  suggestedCategoryName: string | null;
  confidence: number;
  source: ClassificationSource;
  reason: string;
  requiresConfirmation: boolean;
  quotaUsed: boolean;
};

export type BatchClassificationResult = {
  summary: {
    total: number;
    classified: number;
    needsReview: number;
    quotaUsed: number;
  };
  items: ClassificationResult[];
};

// ── Keyword groups ─────────────────────────────────────────────────────────────

type KeywordGroup = { keywords: string[]; labels: string[] };

const KEYWORD_GROUPS: KeywordGroup[] = [
  {
    keywords: ['aluguel', 'locacao', 'locação', 'aluguel do'],
    labels: ['aluguel', 'aluguel', 'rent'],
  },
  {
    keywords: [
      'energia', 'luz', 'conta de luz', 'agua', 'água', 'internet',
      'telefone', 'celular', 'contas de consumo', 'consumo',
    ],
    labels: ['utilitarios', 'utilities', 'agua', 'luz', 'energia', 'internet', 'telefone'],
  },
  {
    keywords: [
      'material', 'luva', 'mascara', 'máscara', 'anestesico', 'anestésico',
      'resina', 'cimento', 'broca', 'caneta', 'agulha', 'seringa',
      'autoclave', 'amalgama', 'amalgâma', 'gaze', 'curativo', 'dental',
      'odontolog', 'sutura', 'fio dental',
    ],
    labels: ['materiais', 'material', 'supplies', 'odontologico', 'odontológico'],
  },
  {
    keywords: [
      'salario', 'salário', 'folha', 'funcionario', 'funcionário',
      'remuneracao', 'remuneração', 'colaborador', 'pagamento de pessoal',
      'pagamento funcionario', 'pro labore', 'pró-labore',
    ],
    labels: ['salarios', 'salário', 'payroll', 'folha', 'pessoal'],
  },
  {
    keywords: [
      'marketing', 'anuncio', 'anúncio', 'trafego', 'tráfego',
      'google ads', 'meta ads', 'instagram', 'facebook', 'propaganda',
      'publicidade', 'campanha', 'impulsionamento',
    ],
    labels: ['marketing', 'publicidade', 'propaganda'],
  },
  {
    keywords: [
      'software', 'sistema', 'assinatura', 'licenca', 'licença',
      'plataforma', 'dentalflow', 'nuvem', 'cloud', 'saas', 'app',
    ],
    labels: ['software', 'sistema', 'ferramentas', 'tecnologia'],
  },
  {
    keywords: [
      'laboratorio', 'laboratório', 'protese', 'prótese', 'proteses',
      'próteses', 'lab ', 'coroa', 'implante', 'ortodontia',
    ],
    labels: ['laboratorio', 'laboratório', 'protese', 'prótese'],
  },
  {
    keywords: [
      'imposto', 'tributo', 'simples', 'das ', ' iss', 'inss', 'fgts',
      'irrf', 'carne', 'carnê', 'pgdas', 'decore', 'receita federal',
    ],
    labels: ['impostos', 'imposto', 'tributos', 'tributo', 'taxes'],
  },
];

const CONFIDENCE_THRESHOLD = 0.75;
const AI_MODEL = 'gpt-4o-mini';
const MAX_AI_TOKENS = 200;

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class ExpenseClassifierService {
  private readonly logger = new Logger(ExpenseClassifierService.name);
  openai: OpenAI | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly analysisRepository: AiAssistantAnalysisRepository,
    private readonly quotaService: AiQuotaService,
  ) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      this.logger.warn('OPENAI_API_KEY not configured — expense classifier AI disabled.');
    } else {
      this.openai = new OpenAI({ apiKey });
    }
  }

  // ── Single classification ──────────────────────────────────────────────────

  async classifyExpense(
    userId: string,
    clinicId: string,
    transactionId: string,
    dto: ClassifyExpenseDto,
  ): Promise<ClassificationResult> {
    const forceAi = dto.forceAi ?? false;

    // Sequential to avoid concurrent pg queries on the same connection.
    const transaction = await this.prisma.financialTransaction.findFirst({
      where: { id: transactionId, clinicId },
    });
    const expenseCategories = await this.prisma.financialCategory.findMany({
      where: { clinicId, type: FinancialTransactionType.EXPENSE },
      orderBy: { name: 'asc' },
    });

    if (!transaction) {
      throw new NotFoundException('Lançamento não encontrado.');
    }
    if (transaction.type !== FinancialTransactionType.EXPENSE) {
      throw new BadRequestException(
        'Apenas lançamentos de despesa podem ser classificados.',
      );
    }

    const quota = await this.quotaService.getQuota(
      clinicId,
      AiAssistantAnalysisType.EXPENSE_CLASSIFICATION,
    );
    if (!quota.allowed) {
      throw new ForbiddenException(
        'A classificação inteligente não está disponível no seu plano atual.',
      );
    }

    // Deterministic rule pass
    const ruleResult = this.applyRules(transaction.description, expenseCategories);

    // Skip AI if rule is confident and user did not force AI
    if (ruleResult.confidence >= CONFIDENCE_THRESHOLD && !forceAi) {
      return {
        transactionId,
        suggestedCategoryId: ruleResult.categoryId,
        suggestedCategoryName: ruleResult.categoryName,
        confidence: ruleResult.confidence,
        source: 'RULE',
        reason: ruleResult.reason,
        requiresConfirmation: false,
        quotaUsed: false,
      };
    }

    // Cache lookup before AI call
    if (!forceAi) {
      const cached = await this.findCache(clinicId, transactionId, transaction.updatedAt);
      if (cached) {
        const content = cached.content as Record<string, unknown>;
        const categoryName = content.suggestedCategoryName as string | null;
        const category = categoryName
          ? expenseCategories.find((c) => c.name === categoryName) ?? null
          : null;
        return {
          transactionId,
          suggestedCategoryId: category?.id ?? null,
          suggestedCategoryName: categoryName,
          confidence: content.confidence as number,
          source: 'CACHE',
          reason: content.reason as string,
          requiresConfirmation: (content.confidence as number) < CONFIDENCE_THRESHOLD,
          quotaUsed: false,
        };
      }
    }

    // AI fallback
    if (quota.remaining <= 0) {
      throw new HttpException(
        'Limite mensal de classificações inteligentes atingido. Tente novamente no próximo mês.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return this.callAi(userId, clinicId, transactionId, transaction, expenseCategories);
  }

  // ── Apply suggested category ───────────────────────────────────────────────

  async applySuggestedCategory(
    clinicId: string,
    transactionId: string,
    dto: ApplySuggestedCategoryDto,
  ) {
    // Sequential to avoid concurrent pg queries on the same connection.
    const transaction = await this.prisma.financialTransaction.findFirst({
      where: { id: transactionId, clinicId },
    });
    const category = await this.prisma.financialCategory.findFirst({
      where: { id: dto.categoryId, clinicId },
    });

    if (!transaction) {
      throw new NotFoundException('Lançamento não encontrado.');
    }
    if (transaction.type !== FinancialTransactionType.EXPENSE) {
      throw new BadRequestException(
        'Apenas lançamentos de despesa podem ter categoria aplicada.',
      );
    }
    if (!category) {
      throw new NotFoundException('Categoria não encontrada.');
    }
    if (category.type !== FinancialTransactionType.EXPENSE) {
      throw new BadRequestException(
        'A categoria selecionada não é do tipo despesa.',
      );
    }

    return this.prisma.financialTransaction.update({
      where: { id: transactionId },
      data: { categoryId: dto.categoryId },
      include: { category: true },
    });
  }

  // ── Batch classification ───────────────────────────────────────────────────

  async classifyBatch(
    userId: string,
    clinicId: string,
    dto: BatchClassifyExpenseDto,
  ): Promise<BatchClassificationResult> {
    const forceAi = dto.forceAi ?? false;

    if (dto.transactionIds.length > 20) {
      throw new BadRequestException('Máximo de 20 lançamentos por lote.');
    }

    // Sequential to avoid concurrent pg queries on the same connection.
    const transactions = await this.prisma.financialTransaction.findMany({
      where: { id: { in: dto.transactionIds }, clinicId },
    });
    const expenseCategories = await this.prisma.financialCategory.findMany({
      where: { clinicId, type: FinancialTransactionType.EXPENSE },
      orderBy: { name: 'asc' },
    });

    const quota = await this.quotaService.getQuota(
      clinicId,
      AiAssistantAnalysisType.EXPENSE_CLASSIFICATION,
    );
    if (!quota.allowed) {
      throw new ForbiddenException(
        'A classificação inteligente não está disponível no seu plano atual.',
      );
    }

    let quotaRemaining = quota.remaining;
    let quotaUsedCount = 0;
    const items: ClassificationResult[] = [];

    for (const txId of dto.transactionIds) {
      const transaction = transactions.find((t) => t.id === txId);

      if (!transaction) {
        items.push(this.noMatchResult(txId, 'Lançamento não encontrado.'));
        continue;
      }
      if (transaction.type !== FinancialTransactionType.EXPENSE) {
        items.push(this.noMatchResult(txId, 'Lançamento não é uma despesa.'));
        continue;
      }

      const ruleResult = this.applyRules(transaction.description, expenseCategories);
      if (ruleResult.confidence >= CONFIDENCE_THRESHOLD && !forceAi) {
        items.push({
          transactionId: txId,
          suggestedCategoryId: ruleResult.categoryId,
          suggestedCategoryName: ruleResult.categoryName,
          confidence: ruleResult.confidence,
          source: 'RULE',
          reason: ruleResult.reason,
          requiresConfirmation: false,
          quotaUsed: false,
        });
        continue;
      }

      // Cache check
      if (!forceAi) {
        const cached = await this.findCache(clinicId, txId, transaction.updatedAt);
        if (cached) {
          const content = cached.content as Record<string, unknown>;
          const categoryName = content.suggestedCategoryName as string | null;
          const category = categoryName
            ? expenseCategories.find((c) => c.name === categoryName) ?? null
            : null;
          items.push({
            transactionId: txId,
            suggestedCategoryId: category?.id ?? null,
            suggestedCategoryName: categoryName,
            confidence: content.confidence as number,
            source: 'CACHE',
            reason: content.reason as string,
            requiresConfirmation: (content.confidence as number) < CONFIDENCE_THRESHOLD,
            quotaUsed: false,
          });
          continue;
        }
      }

      if (quotaRemaining <= 0) {
        items.push(
          this.noMatchResult(txId, 'Limite de classificações inteligentes atingido.'),
        );
        continue;
      }

      const aiResult = await this.callAi(
        userId,
        clinicId,
        txId,
        transaction,
        expenseCategories,
      );
      items.push(aiResult);
      if (aiResult.quotaUsed) {
        quotaRemaining--;
        quotaUsedCount++;
      }
    }

    const classified = items.filter(
      (i) => i.suggestedCategoryId !== null && !i.requiresConfirmation,
    ).length;

    return {
      summary: {
        total: dto.transactionIds.length,
        classified,
        needsReview: items.length - classified,
        quotaUsed: quotaUsedCount,
      },
      items,
    };
  }

  // ── Rule engine ────────────────────────────────────────────────────────────

  private applyRules(
    description: string,
    categories: { id: string; name: string }[],
  ): { categoryId: string | null; categoryName: string | null; confidence: number; reason: string } {
    const normalized = this.normalize(description);

    // Pass 1: exact or partial category-name match
    for (const cat of categories) {
      const catNorm = this.normalize(cat.name);
      if (normalized.includes(catNorm) && catNorm.length > 2) {
        return {
          categoryId: cat.id,
          categoryName: cat.name,
          confidence: 0.90,
          reason: `Descrição contém o nome da categoria "${cat.name}".`,
        };
      }
    }

    // Pass 2: keyword → semantic label → best category name match
    for (const group of KEYWORD_GROUPS) {
      const matchedKeyword = group.keywords.find((kw) =>
        normalized.includes(this.normalize(kw)),
      );
      if (!matchedKeyword) continue;

      const category = this.findBestCategory(categories, group.labels);
      if (category) {
        return {
          categoryId: category.id,
          categoryName: category.name,
          confidence: 0.85,
          reason: `Palavra-chave "${matchedKeyword}" indica a categoria "${category.name}".`,
        };
      }

      // Keyword matched but no clinic category found for this semantic
      return {
        categoryId: null,
        categoryName: null,
        confidence: 0.50,
        reason: `Palavra-chave "${matchedKeyword}" encontrada mas nenhuma categoria correspondente.`,
      };
    }

    return {
      categoryId: null,
      categoryName: null,
      confidence: 0.0,
      reason: 'Nenhuma regra determinística aplicável.',
    };
  }

  private findBestCategory(
    categories: { id: string; name: string }[],
    labels: string[],
  ): { id: string; name: string } | null {
    for (const label of labels) {
      const labelNorm = this.normalize(label);
      const match = categories.find((c) => this.normalize(c.name).includes(labelNorm));
      if (match) return match;
    }
    return null;
  }

  private normalize(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ── Cache ──────────────────────────────────────────────────────────────────

  private async findCache(clinicId: string, transactionId: string, updatedAt: Date) {
    const record = await this.prisma.aiAssistantAnalysis.findFirst({
      where: {
        clinicId,
        type: AiAssistantAnalysisType.EXPENSE_CLASSIFICATION,
        status: AiAssistantAnalysisStatus.SUCCESS,
        content: { path: ['transactionId'], equals: transactionId },
      },
      orderBy: { generatedAt: 'desc' },
    });

    if (!record) return null;
    const content = record.content as Record<string, unknown>;
    if (content.transactionUpdatedAt !== updatedAt.toISOString()) return null;
    return record;
  }

  // ── AI call ────────────────────────────────────────────────────────────────

  private async callAi(
    userId: string,
    clinicId: string,
    transactionId: string,
    transaction: { description: string; amount: object; transactionDate: Date; updatedAt: Date },
    categories: { id: string; name: string }[],
  ): Promise<ClassificationResult> {
    this.assertAiEnabled();

    const categoryNames = categories.map((c) => c.name);
    const amountBRL = Number(transaction.amount).toFixed(2);
    const month = transaction.transactionDate.toISOString().slice(0, 7);

    const context = {
      description: transaction.description,
      amountBRL,
      month,
      availableCategories: categoryNames,
    };

    const systemPrompt = `Você é um classificador de despesas financeiras para uma clínica odontológica brasileira.
Sua única função é sugerir a categoria mais adequada para a despesa com base na descrição fornecida.
Regras obrigatórias:
- Escolha SOMENTE uma categoria da lista "availableCategories".
- Se nenhuma categoria for adequada, retorne categoryName como null.
- NÃO invente categorias.
- reason deve ser curto e em português brasileiro.
- Retorne APENAS JSON válido no formato: {"categoryName": string | null, "confidence": number, "reason": string}
- confidence deve ser entre 0.0 e 1.0.`;

    const start = Date.now();
    let aiCategoryName: string | null = null;
    let aiConfidence = 0.7;
    let aiReason = '';

    try {
      const response = await this.openai!.chat.completions.create({
        model: AI_MODEL,
        temperature: 0.1,
        max_tokens: MAX_AI_TOKENS,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify(context) },
        ],
      });

      const raw = response.choices[0]?.message?.content ?? '{}';
      const parsed = JSON.parse(raw) as {
        categoryName?: string | null;
        confidence?: number;
        reason?: string;
      };

      aiCategoryName = parsed.categoryName ?? null;
      aiConfidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.7;
      aiReason = parsed.reason ?? 'Sugestão da IA.';

      // Safety: reject category not in available list
      if (
        aiCategoryName !== null &&
        !categoryNames.some(
          (n) => n.toLowerCase() === (aiCategoryName as string).toLowerCase(),
        )
      ) {
        aiCategoryName = null;
        aiReason = 'Categoria sugerida pela IA não encontrada na lista disponível.';
        aiConfidence = 0.0;
      }

      const durationMs = Date.now() - start;
      this.logger.log(
        JSON.stringify({
          event: 'expense_classification_success',
          durationMs,
          model: AI_MODEL,
          createdAt: new Date().toISOString(),
        }),
      );

      // Persist to cache (best-effort)
      this.analysisRepository
        .saveSuccess({
          clinicId,
          userId,
          type: AiAssistantAnalysisType.EXPENSE_CLASSIFICATION,
          content: {
            transactionId,
            suggestedCategoryName: aiCategoryName,
            confidence: aiConfidence,
            reason: aiReason,
            transactionUpdatedAt: transaction.updatedAt.toISOString(),
          },
          model: AI_MODEL,
          generatedAt: new Date(),
          periodStart: null,
          periodEnd: null,
        })
        .catch(() => undefined);
    } catch (err: unknown) {
      const durationMs = Date.now() - start;
      const isRateLimit =
        typeof err === 'object' && err !== null && (err as { status?: number }).status === 429;

      this.logger.error(
        JSON.stringify({
          event: 'expense_classification_error',
          errorCode: isRateLimit ? 'RATE_LIMIT' : 'OPENAI_ERROR',
          durationMs,
          model: AI_MODEL,
          createdAt: new Date().toISOString(),
        }),
      );

      this.analysisRepository
        .saveError({
          clinicId,
          userId,
          type: AiAssistantAnalysisType.EXPENSE_CLASSIFICATION,
          model: AI_MODEL,
          errorMessage: err instanceof Error ? err.message : 'Unknown error',
        })
        .catch(() => undefined);

      if (isRateLimit) {
        throw new ServiceUnavailableException(
          'O serviço de classificação está temporariamente indisponível. Tente novamente em instantes.',
        );
      }
      throw new InternalServerErrorException(
        'Não foi possível classificar a despesa. Tente novamente.',
      );
    }

    const matchedCategory = aiCategoryName
      ? categories.find(
          (c) => c.name.toLowerCase() === aiCategoryName.toLowerCase(),
        ) ?? null
      : null;

    return {
      transactionId,
      suggestedCategoryId: matchedCategory?.id ?? null,
      suggestedCategoryName: aiCategoryName,
      confidence: aiConfidence,
      source: aiCategoryName ? 'AI' : 'NO_MATCH',
      reason: aiReason,
      requiresConfirmation: aiConfidence < CONFIDENCE_THRESHOLD,
      quotaUsed: true,
    };
  }

  private assertAiEnabled() {
    if (!this.openai) {
      throw new ServiceUnavailableException(
        'O classificador inteligente está indisponível no momento. Contate o suporte.',
      );
    }
  }

  private noMatchResult(transactionId: string, reason: string): ClassificationResult {
    return {
      transactionId,
      suggestedCategoryId: null,
      suggestedCategoryName: null,
      confidence: 0,
      source: 'NO_MATCH',
      reason,
      requiresConfirmation: true,
      quotaUsed: false,
    };
  }
}
