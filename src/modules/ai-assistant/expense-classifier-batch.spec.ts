import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { FinancialTransactionType } from '@prisma/client';

import { ExpenseClassifierService } from './expense-classifier.service';

/**
 * Batch expense classification, and applying a suggestion.
 *
 * The single-transaction path has a suite. The batch does not simply loop it:
 * it carries a quota across the whole request, and each transaction takes one
 * of four routes — the rule engine, a cached answer, the model, or a refusal.
 * Only the fourth is free, and only the third spends quota.
 *
 * The quota accounting is what these tests exist for. A batch that keeps
 * calling the model after the allowance runs out bills the clinic for work it
 * did not buy; one that charges for a rule match or a cache hit bills it for
 * work nobody did.
 */

const CLINIC = 'clinic-1';
const USER = 'user-1';
const NOW = new Date('2026-06-15T10:00:00.000Z');

const CATEGORIES = [
  { id: 'cat-aluguel', name: 'Aluguel', type: 'EXPENSE' },
  { id: 'cat-materiais', name: 'Materiais', type: 'EXPENSE' },
];

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    clinicId: CLINIC,
    type: FinancialTransactionType.EXPENSE,
    description: 'Pagamento aluguel escritorio',
    amount: '1500.00',
    transactionDate: NOW,
    updatedAt: NOW,
    appointmentId: null,
    profileId: null,
    ...overrides,
  };
}

function createHarness() {
  const prisma = {
    financialTransaction: {
      findFirst: jest.fn().mockResolvedValue(transaction()),
      findMany: jest.fn().mockResolvedValue([transaction()]),
      update: jest.fn().mockResolvedValue({ id: 'tx-1' }),
    },
    financialCategory: {
      findMany: jest.fn().mockResolvedValue(CATEGORIES),
      findFirst: jest.fn().mockResolvedValue(CATEGORIES[0]),
    },
    aiAssistantAnalysis: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    },
  };

  const repository = {
    saveSuccess: jest.fn().mockResolvedValue({}),
    saveError: jest.fn().mockResolvedValue({}),
    findLatest: jest.fn().mockResolvedValue(null),
  };

  const quotaService = {
    getQuota: jest.fn().mockResolvedValue({
      allowed: true,
      planKey: 'PRO',
      used: 0,
      remaining: 10,
      limit: 10,
    }),
  };

  // A stubbed provider, so the model route is available and distinguishable
  // from the rule and cache routes rather than collapsing into an error.
  const completions = jest.fn().mockResolvedValue({
    choices: [
      {
        message: {
          content: JSON.stringify({
            categoryName: 'Materiais',
            confidence: 0.95,
            reason: 'resposta do modelo',
          }),
        },
      },
    ],
  });

  const service = new ExpenseClassifierService(
    prisma as never,
    repository as never,
    quotaService as never,
  );
  service.openai = {
    chat: { completions: { create: completions } },
  } as never;

  return { service, prisma, repository, quotaService, completions };
}

/** A cache row for a transaction, keyed on the row's own updatedAt. */
function cacheRow(content: Record<string, unknown>) {
  return {
    content: { transactionUpdatedAt: NOW.toISOString(), ...content },
  };
}

describe('ExpenseClassifierService — batch', () => {
  let h: ReturnType<typeof createHarness>;

  beforeEach(() => {
    h = createHarness();
  });

  function classify(ids: string[], forceAi = false) {
    return h.service.classifyBatch(USER, CLINIC, {
      transactionIds: ids,
      forceAi,
    } as never);
  }

  // ── Size and plan ──────────────────────────────────────────────────────────

  it('refuses a batch of more than twenty', async () => {
    const ids = Array.from({ length: 21 }, (_, i) => `tx-${i}`);

    await expect(classify(ids)).rejects.toThrow(BadRequestException);
    expect(h.prisma.financialTransaction.findMany).not.toHaveBeenCalled();
  });

  it('accepts a batch of exactly twenty', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `tx-${i}`);
    h.prisma.financialTransaction.findMany.mockResolvedValue([]);

    await expect(classify(ids)).resolves.toBeDefined();
  });

  it('refuses when the plan does not include the classifier', async () => {
    h.quotaService.getQuota.mockResolvedValue({
      allowed: false,
      planKey: 'BASIC',
      used: 0,
      remaining: 0,
      limit: 0,
    });

    await expect(classify(['tx-1'])).rejects.toThrow(ForbiddenException);
  });

  it('reads only transactions belonging to the caller’s clinic', async () => {
    await classify(['tx-1']);

    expect(
      h.prisma.financialTransaction.findMany.mock.calls[0][0].where,
    ).toEqual({ id: { in: ['tx-1'] }, clinicId: CLINIC });
  });

  // ── Per-transaction routing ────────────────────────────────────────────────

  describe('each transaction', () => {
    it('is classified by the rule engine when the description is unambiguous', async () => {
      const result = await classify(['tx-1']);

      expect(result.items[0]).toMatchObject({
        transactionId: 'tx-1',
        source: 'RULE',
        suggestedCategoryId: 'cat-aluguel',
        requiresConfirmation: false,
        quotaUsed: false,
      });
    });

    it('spends no quota on a rule match', async () => {
      const result = await classify(['tx-1']);

      expect(result.summary.quotaUsed).toBe(0);
    });

    it('is reported as not found when it is not in the clinic', async () => {
      h.prisma.financialTransaction.findMany.mockResolvedValue([]);

      const result = await classify(['ghost']);

      expect(result.items[0]).toMatchObject({
        transactionId: 'ghost',
        source: 'NO_MATCH',
        reason: 'Lançamento não encontrado.',
        requiresConfirmation: true,
      });
    });

    it('is skipped when it is income rather than an expense', async () => {
      h.prisma.financialTransaction.findMany.mockResolvedValue([
        transaction({ type: FinancialTransactionType.INCOME }),
      ]);

      const result = await classify(['tx-1']);

      expect(result.items[0]).toMatchObject({
        source: 'NO_MATCH',
        reason: 'Lançamento não é uma despesa.',
      });
    });

    it('reuses a cached answer instead of asking again', async () => {
      h.prisma.financialTransaction.findMany.mockResolvedValue([
        transaction({ description: 'pagamento indecifravel xyz' }),
      ]);
      h.prisma.aiAssistantAnalysis.findFirst.mockResolvedValue(
        cacheRow({
          suggestedCategoryName: 'Materiais',
          confidence: 0.9,
          reason: 'cached',
        }),
      );

      const result = await classify(['tx-1']);

      expect(result.items[0]).toMatchObject({
        source: 'CACHE',
        suggestedCategoryId: 'cat-materiais',
        suggestedCategoryName: 'Materiais',
        quotaUsed: false,
      });
    });

    it('still flags a low-confidence cached answer for review', async () => {
      h.prisma.financialTransaction.findMany.mockResolvedValue([
        transaction({ description: 'pagamento indecifravel xyz' }),
      ]);
      h.prisma.aiAssistantAnalysis.findFirst.mockResolvedValue(
        cacheRow({
          suggestedCategoryName: 'Materiais',
          confidence: 0.4,
          reason: 'cached',
        }),
      );

      const result = await classify(['tx-1']);

      expect(result.items[0]).toMatchObject({
        source: 'CACHE',
        requiresConfirmation: true,
      });
    });

    it('carries a cached answer naming a category that no longer exists', async () => {
      h.prisma.financialTransaction.findMany.mockResolvedValue([
        transaction({ description: 'pagamento indecifravel xyz' }),
      ]);
      h.prisma.aiAssistantAnalysis.findFirst.mockResolvedValue(
        cacheRow({
          suggestedCategoryName: 'Categoria apagada',
          confidence: 0.9,
          reason: 'cached',
        }),
      );

      const result = await classify(['tx-1']);

      // The name survives for the reader; the id cannot be invented.
      expect(result.items[0]).toMatchObject({
        suggestedCategoryId: null,
        suggestedCategoryName: 'Categoria apagada',
      });
    });

    it('ignores the cache when the caller forces a fresh answer', async () => {
      h.prisma.aiAssistantAnalysis.findFirst.mockResolvedValue(
        cacheRow({ suggestedCategoryName: 'Materiais', confidence: 0.9 }),
      );

      await classify(['tx-1'], true);

      expect(h.prisma.aiAssistantAnalysis.findFirst).not.toHaveBeenCalled();
    });

    it('ignores the rule engine when the caller forces a fresh answer', async () => {
      const result = await classify(['tx-1'], true);

      // The description matches a rule cleanly; forceAi must still reach the
      // model, which is the whole point of asking for it.
      expect(result.items[0].source).not.toBe('RULE');
      expect(h.completions).toHaveBeenCalled();
    });

    it('spends quota on a model answer, and only on that', async () => {
      h.prisma.financialTransaction.findMany.mockResolvedValue([
        transaction({ id: 'tx-1' }),
        transaction({ id: 'tx-2', description: 'pagamento indecifravel xyz' }),
      ]);

      const result = await classify(['tx-1', 'tx-2']);

      // tx-1 matched a rule, tx-2 reached the model.
      expect(result.summary.quotaUsed).toBe(1);
      expect(h.completions).toHaveBeenCalledTimes(1);
    });

    it('never suggests a category the clinic does not have', async () => {
      h.completions.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                categoryName: 'Categoria inventada',
                confidence: 0.99,
                reason: 'x',
              }),
            },
          },
        ],
      });
      h.prisma.financialTransaction.findMany.mockResolvedValue([
        transaction({ description: 'pagamento indecifravel xyz' }),
      ]);

      const result = await classify(['tx-1']);

      // The model is instructed to pick from a list; the service verifies it
      // rather than trusting it.
      expect(result.items[0].suggestedCategoryId).toBeNull();
      expect(result.items[0].confidence).toBe(0);
    });
  });

  // ── The allowance ──────────────────────────────────────────────────────────

  describe('the allowance', () => {
    it('refuses further work once it is exhausted', async () => {
      h.quotaService.getQuota.mockResolvedValue({
        allowed: true,
        planKey: 'PRO',
        used: 10,
        remaining: 0,
        limit: 10,
      });
      h.prisma.financialTransaction.findMany.mockResolvedValue([
        transaction({ description: 'pagamento indecifravel xyz' }),
      ]);

      const result = await classify(['tx-1']);

      expect(result.items[0]).toMatchObject({
        source: 'NO_MATCH',
        reason: 'Limite de classificações inteligentes atingido.',
        quotaUsed: false,
      });
      // The model was never reached, so the clinic is not billed for it.
      expect(h.completions).not.toHaveBeenCalled();
    });

    it('still classifies by rule after it is exhausted', async () => {
      h.quotaService.getQuota.mockResolvedValue({
        allowed: true,
        planKey: 'PRO',
        used: 10,
        remaining: 0,
        limit: 10,
      });

      const result = await classify(['tx-1']);

      // A rule match costs nothing, so running out of model calls must not
      // stop the free route.
      expect(result.items[0].source).toBe('RULE');
    });
  });

  // ── The summary ────────────────────────────────────────────────────────────

  describe('the summary', () => {
    it('counts confident suggestions as classified and the rest for review', async () => {
      h.prisma.financialTransaction.findMany.mockResolvedValue([
        transaction({ id: 'tx-1' }),
        transaction({ id: 'tx-2', description: 'pagamento indecifravel xyz' }),
      ]);
      // tx-1 matches a rule outright; the model is unsure about tx-2.
      h.completions.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                categoryName: 'Materiais',
                confidence: 0.4,
                reason: 'incerto',
              }),
            },
          },
        ],
      });

      const result = await classify(['tx-1', 'tx-2']);

      expect(result.summary).toMatchObject({
        total: 2,
        classified: 1,
        needsReview: 1,
      });
    });

    it('counts every requested id, including ones it could not find', async () => {
      h.prisma.financialTransaction.findMany.mockResolvedValue([]);

      const result = await classify(['a', 'b', 'c']);

      expect(result.summary.total).toBe(3);
      expect(result.items).toHaveLength(3);
    });
  });

  // ── Applying a suggestion ──────────────────────────────────────────────────

  describe('applying a suggestion', () => {
    function apply(categoryId = 'cat-aluguel') {
      return h.service.applySuggestedCategory(CLINIC, 'tx-1', {
        categoryId,
      } as never);
    }

    it('writes the category onto the transaction', async () => {
      await apply();

      expect(h.prisma.financialTransaction.update).toHaveBeenCalledWith({
        where: { id: 'tx-1' },
        data: { categoryId: 'cat-aluguel' },
        include: { category: true },
      });
    });

    it('reports a transaction from another clinic as not found', async () => {
      h.prisma.financialTransaction.findFirst.mockResolvedValue(null);

      await expect(apply()).rejects.toThrow(NotFoundException);
      expect(h.prisma.financialTransaction.update).not.toHaveBeenCalled();
    });

    it('reports a category from another clinic as not found', async () => {
      h.prisma.financialCategory.findFirst.mockResolvedValue(null);

      await expect(apply('foreign')).rejects.toThrow(NotFoundException);
      expect(h.prisma.financialTransaction.update).not.toHaveBeenCalled();
    });

    it('refuses to categorise an income transaction', async () => {
      h.prisma.financialTransaction.findFirst.mockResolvedValue(
        transaction({ type: FinancialTransactionType.INCOME }),
      );

      await expect(apply()).rejects.toThrow(BadRequestException);
    });

    it('refuses an income category on an expense', async () => {
      h.prisma.financialCategory.findFirst.mockResolvedValue({
        id: 'cat-receita',
        name: 'Consultas',
        type: FinancialTransactionType.INCOME,
      });

      // Filing an expense under an income category corrupts every total
      // derived from the pair.
      await expect(apply('cat-receita')).rejects.toThrow(BadRequestException);
      expect(h.prisma.financialTransaction.update).not.toHaveBeenCalled();
    });

    it('scopes both lookups to the clinic', async () => {
      await apply();

      expect(
        h.prisma.financialTransaction.findFirst.mock.calls[0][0].where,
      ).toMatchObject({ id: 'tx-1', clinicId: CLINIC });
      expect(
        h.prisma.financialCategory.findFirst.mock.calls[0][0].where,
      ).toEqual({ id: 'cat-aluguel', clinicId: CLINIC });
    });
  });
});
