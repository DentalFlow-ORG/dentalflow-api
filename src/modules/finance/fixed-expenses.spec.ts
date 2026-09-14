import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  FinancialTransactionType as Type,
  FixedExpenseRecurrence,
  Prisma,
} from '@prisma/client';

import { FinanceService } from './finance.service';

/**
 * Fixed expenses: the recurring costs a clinic carries, and the transaction
 * each occurrence generates.
 *
 * The write paths and the summary have suites. This one had none, and it is
 * where a clinic's rent turns into a payable. The rule that matters is the
 * one guarding against duplicates: an occurrence is keyed on
 * (clinic, fixed expense, due date), so generating the same month twice
 * updates the payable rather than booking the rent again.
 *
 * The due-date arithmetic is the other half. A monthly expense due on the 31st
 * must land on the 30th in a thirty-day month rather than roll into the next.
 */

const CLINIC = 'clinic-1';
const USER = 'user-1';
const CATEGORY = 'category-1';
const FIXED = 'fixed-1';

/** 2026-06-15; June has 30 days, which the clamping tests rely on. */
const FROZEN_NOW = new Date('2026-06-15T12:00:00.000Z');

function fixedExpenseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: FIXED,
    clinicId: CLINIC,
    categoryId: CATEGORY,
    description: 'Aluguel',
    amount: new Prisma.Decimal(2_500),
    recurrence: FixedExpenseRecurrence.MONTHLY,
    dueDay: 10,
    isActive: true,
    ...overrides,
  };
}

function createPrisma() {
  return {
    fixedExpense: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(fixedExpenseRow()),
      create: jest.fn().mockResolvedValue(fixedExpenseRow()),
      update: jest.fn().mockResolvedValue(fixedExpenseRow()),
    },
    financialCategory: {
      findFirst: jest.fn().mockResolvedValue({ id: CATEGORY, type: 'EXPENSE' }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    financialTransaction: {
      upsert: jest.fn().mockResolvedValue({ id: 'tx-1' }),
    },
  };
}

describe('FinanceService — fixed expenses', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let service: FinanceService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(FROZEN_NOW);
    prisma = createPrisma();
    service = new FinanceService(prisma as never);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── The expense itself ─────────────────────────────────────────────────────

  describe('recording one', () => {
    const dto = {
      categoryId: CATEGORY,
      description: 'Aluguel',
      amount: 2500,
      recurrence: FixedExpenseRecurrence.MONTHLY,
      dueDay: 10,
      startDate: '2026-01-01',
    };

    it('lists the clinic’s, active first and by due day', async () => {
      await service.listFixedExpenses(CLINIC);

      expect(prisma.fixedExpense.findMany.mock.calls[0][0]).toMatchObject({
        where: { clinicId: CLINIC },
        orderBy: [{ isActive: 'desc' }, { dueDay: 'asc' }],
      });
    });

    it('stores it against the clinic and the author', async () => {
      await service.createFixedExpense(CLINIC, USER, dto as never);

      expect(prisma.fixedExpense.create.mock.calls[0][0].data).toMatchObject({
        clinicId: CLINIC,
        categoryId: CATEGORY,
        description: 'Aluguel',
        recurrence: FixedExpenseRecurrence.MONTHLY,
        dueDay: 10,
        isActive: true,
        createdByUserId: USER,
      });
    });

    it('stores the amount as a two-place decimal', async () => {
      await service.createFixedExpense(CLINIC, USER, {
        ...dto,
        amount: 2500.456,
      } as never);

      const amount = prisma.fixedExpense.create.mock.calls[0][0].data
        .amount as Prisma.Decimal;
      expect(amount.toFixed(2)).toBe('2500.46');
    });

    it('requires the category to be an expense category in this clinic', async () => {
      await service.createFixedExpense(CLINIC, USER, dto as never);

      expect(
        prisma.financialCategory.findFirst.mock.calls[0][0].where,
      ).toMatchObject({ id: CATEGORY, clinicId: CLINIC, type: Type.EXPENSE });
    });

    it('refuses a category from another clinic', async () => {
      prisma.financialCategory.findFirst.mockResolvedValue(null);

      await expect(
        service.createFixedExpense(CLINIC, USER, dto as never),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.fixedExpense.create).not.toHaveBeenCalled();
    });

    it('accepts an open-ended expense with no end date', async () => {
      await service.createFixedExpense(CLINIC, USER, dto as never);

      // Stored as an explicit null rather than left absent, so "runs forever"
      // is a value in the column instead of an assumption about a gap.
      expect(
        prisma.fixedExpense.create.mock.calls[0][0].data.endDate,
      ).toBeNull();
    });

    it('stores the dates as UTC midnight of the calendar day', async () => {
      await service.createFixedExpense(CLINIC, USER, {
        ...dto,
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      } as never);

      const data = prisma.fixedExpense.create.mock.calls[0][0].data as {
        startDate: Date;
        endDate: Date;
      };
      expect(data.startDate.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(data.endDate.toISOString()).toBe('2026-12-31T00:00:00.000Z');
    });
  });

  describe('editing one', () => {
    it('writes only the fields the caller sent', async () => {
      await service.updateFixedExpense(CLINIC, FIXED, {
        description: 'Aluguel reajustado',
      } as never);

      expect(prisma.fixedExpense.update.mock.calls[0][0].data).toEqual({
        description: 'Aluguel reajustado',
      });
    });

    it('validates a new category before moving the expense to it', async () => {
      prisma.fixedExpense.findFirst.mockResolvedValue(fixedExpenseRow());
      prisma.financialCategory.findFirst.mockResolvedValue(null);

      await expect(
        service.updateFixedExpense(CLINIC, FIXED, {
          categoryId: 'foreign',
        } as never),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.fixedExpense.update).not.toHaveBeenCalled();
    });

    it('runs no category check when the category is unchanged', async () => {
      await service.updateFixedExpense(CLINIC, FIXED, {
        amount: 3000,
      } as never);

      expect(prisma.financialCategory.findFirst).not.toHaveBeenCalled();
    });

    it('clears the end date when the caller sends null', async () => {
      await service.updateFixedExpense(CLINIC, FIXED, {
        endDate: null,
      } as never);

      expect(prisma.fixedExpense.update.mock.calls[0][0].data).toEqual({
        endDate: null,
      });
    });

    it('leaves the end date alone when the update omits it', async () => {
      await service.updateFixedExpense(CLINIC, FIXED, {
        amount: 3000,
      } as never);

      // `undefined` and `null` mean different things here: one is "not
      // mentioned", the other is "make this open-ended".
      expect(
        prisma.fixedExpense.update.mock.calls[0][0].data,
      ).not.toHaveProperty('endDate');
    });

    it('reports one from another clinic as not found', async () => {
      prisma.fixedExpense.findFirst.mockResolvedValue(null);

      await expect(
        service.updateFixedExpense(CLINIC, 'foreign', {
          amount: 1,
        } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it('scopes the lookup to the clinic', async () => {
      await service.updateFixedExpense(CLINIC, FIXED, { amount: 1 } as never);

      expect(
        prisma.fixedExpense.findFirst.mock.calls[0][0].where,
      ).toMatchObject({ id: FIXED, clinicId: CLINIC });
    });

    it('deactivates rather than deletes', async () => {
      await service.deleteFixedExpense(CLINIC, FIXED);

      // Transactions already generated point at this row; removing it would
      // orphan a clinic's expense history.
      expect(prisma.fixedExpense.update).toHaveBeenCalledWith({
        where: { id: FIXED },
        data: { isActive: false },
      });
    });

    it('refuses to deactivate one from another clinic', async () => {
      prisma.fixedExpense.findFirst.mockResolvedValue(null);

      await expect(
        service.deleteFixedExpense(CLINIC, 'foreign'),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.fixedExpense.update).not.toHaveBeenCalled();
    });
  });

  // ── Generating the payable ─────────────────────────────────────────────────

  describe('generating an occurrence', () => {
    async function generate(period?: string, row = fixedExpenseRow()) {
      prisma.fixedExpense.findFirst.mockResolvedValue(row);
      await service.generateFixedExpenseOccurrence(CLINIC, USER, FIXED, period);
      return prisma.financialTransaction.upsert.mock.calls[0][0] as {
        where: { clinicId_fixedExpenseId_dueDate: { dueDate: Date } };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      };
    }

    it('books a pending expense against the fixed expense', async () => {
      const call = await generate('2026-06');

      expect(call.create).toMatchObject({
        clinicId: CLINIC,
        type: 'EXPENSE',
        source: 'FIXED_EXPENSE',
        fixedExpenseId: FIXED,
        status: 'PENDING',
        createdByUserId: USER,
        description: 'Aluguel',
      });
    });

    it('keys the upsert on clinic, expense and due date', async () => {
      const call = await generate('2026-06');

      // This composite key is what makes generating the same month twice an
      // update rather than a second month's rent.
      expect(call.where.clinicId_fixedExpenseId_dueDate).toEqual({
        clinicId: CLINIC,
        fixedExpenseId: FIXED,
        dueDate: new Date('2026-06-10T00:00:00.000Z'),
      });
    });

    it('leaves the status alone when regenerating', async () => {
      const call = await generate('2026-06');

      // Regenerating must not un-pay an occurrence someone already settled.
      expect(call.update).not.toHaveProperty('status');
      expect(call.update).toMatchObject({ amount: expect.anything() });
    });

    it('dates a monthly occurrence on its due day in the given month', async () => {
      const call = await generate('2026-03');

      expect(
        call.where.clinicId_fixedExpenseId_dueDate.dueDate.toISOString(),
      ).toBe('2026-03-10T00:00:00.000Z');
    });

    it('clamps a due day past the end of a short month', async () => {
      // Due on the 31st, generated for June: the 30th, not July the 1st.
      const call = await generate('2026-06', fixedExpenseRow({ dueDay: 31 }));

      expect(
        call.where.clinicId_fixedExpenseId_dueDate.dueDate.toISOString(),
      ).toBe('2026-06-30T00:00:00.000Z');
    });

    it('clamps to the end of February', async () => {
      const call = await generate('2026-02', fixedExpenseRow({ dueDay: 30 }));

      expect(
        call.where.clinicId_fixedExpenseId_dueDate.dueDate.toISOString(),
      ).toBe('2026-02-28T00:00:00.000Z');
    });

    it('places a yearly occurrence in January', async () => {
      const call = await generate(
        '2026-06',
        fixedExpenseRow({
          recurrence: FixedExpenseRecurrence.YEARLY,
          dueDay: 15,
        }),
      );

      expect(
        call.where.clinicId_fixedExpenseId_dueDate.dueDate.toISOString(),
      ).toBe('2026-01-15T00:00:00.000Z');
    });

    it('counts a weekly due day from the start of the period', async () => {
      const call = await generate(
        '2026-06',
        fixedExpenseRow({
          recurrence: FixedExpenseRecurrence.WEEKLY,
          dueDay: 3,
        }),
      );

      expect(
        call.where.clinicId_fixedExpenseId_dueDate.dueDate.toISOString(),
      ).toBe('2026-06-03T00:00:00.000Z');
    });

    it('falls back to the current month when no period is given', async () => {
      const call = await generate(undefined);

      expect(
        call.where.clinicId_fixedExpenseId_dueDate.dueDate.toISOString(),
      ).toBe('2026-06-10T00:00:00.000Z');
    });

    it('refuses to generate from a deactivated expense', async () => {
      prisma.fixedExpense.findFirst.mockResolvedValue(
        fixedExpenseRow({ isActive: false }),
      );

      await expect(
        service.generateFixedExpenseOccurrence(CLINIC, USER, FIXED, '2026-06'),
      ).rejects.toThrow(ConflictException);
      expect(prisma.financialTransaction.upsert).not.toHaveBeenCalled();
    });

    it('refuses an expense from another clinic', async () => {
      prisma.fixedExpense.findFirst.mockResolvedValue(null);

      await expect(
        service.generateFixedExpenseOccurrence(
          CLINIC,
          USER,
          'foreign',
          '2026-06',
        ),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.financialTransaction.upsert).not.toHaveBeenCalled();
    });
  });
});
