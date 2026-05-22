import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  FinancialTransactionSource,
  FinancialTransactionStatus,
  FinancialTransactionType,
  FixedExpenseRecurrence,
} from '@prisma/client';

import { AppointmentPaymentDto } from './appointment-payment.dto';
import { CreateFinancialTransactionDto } from './create-financial-transaction.dto';
import { CreateFixedExpenseDto } from './create-fixed-expense.dto';
import {
  GenerateFixedExpenseOccurrenceQueryDto,
  ListFinancialTransactionsDto,
} from './finance-query.dto';
import { FinanceIdParamDto } from './finance-param.dto';

async function validateDto<T extends object>(
  cls: new () => T,
  payload: Record<string, unknown>,
) {
  return validate(plainToInstance(cls, payload));
}

describe('finance DTO validation', () => {
  it('rejects invalid and overlong IDs', async () => {
    const invalid = await validateDto(FinanceIdParamDto, { id: '../category' });
    const overlong = await validateDto(FinanceIdParamDto, { id: 'a'.repeat(65) });
    const body = await validateDto(CreateFinancialTransactionDto, {
      type: FinancialTransactionType.EXPENSE,
      categoryId: 'category/1',
      amount: 10,
      description: 'Compra',
      transactionDate: '2026-05-22',
    });

    expect(invalid.some((error) => error.property === 'id')).toBe(true);
    expect(overlong.some((error) => error.property === 'id')).toBe(true);
    expect(body.some((error) => error.property === 'categoryId')).toBe(true);
  });

  it('rejects invalid calendar dates', async () => {
    const errors = await validateDto(CreateFinancialTransactionDto, {
      type: FinancialTransactionType.INCOME,
      categoryId: 'category_1',
      amount: 10,
      description: 'Receita',
      transactionDate: '2026-02-31',
      dueDate: '2026-13-01',
      status: FinancialTransactionStatus.PENDING,
      source: FinancialTransactionSource.MANUAL,
    });

    expect(errors.some((error) => error.property === 'transactionDate')).toBe(true);
    expect(errors.some((error) => error.property === 'dueDate')).toBe(true);
  });

  it('rejects overlarge amount', async () => {
    const errors = await validateDto(CreateFixedExpenseDto, {
      categoryId: 'category_1',
      description: 'Despesa',
      amount: 100_000_000,
      recurrence: FixedExpenseRecurrence.MONTHLY,
      dueDay: 10,
      startDate: '2026-05-22',
    });

    expect(errors.some((error) => error.property === 'amount')).toBe(true);
  });

  it('rejects zero or negative amount', async () => {
    const zero = await validateDto(AppointmentPaymentDto, {
      appointmentId: 'appointment_1',
      amount: 0,
    });
    const negative = await validateDto(CreateFixedExpenseDto, {
      categoryId: 'category_1',
      description: 'Despesa',
      amount: -1,
      recurrence: FixedExpenseRecurrence.MONTHLY,
      dueDay: 10,
      startDate: '2026-05-22',
    });

    expect(zero.some((error) => error.property === 'amount')).toBe(true);
    expect(negative.some((error) => error.property === 'amount')).toBe(true);
  });

  it('rejects overlarge pagination', async () => {
    const errors = await validateDto(ListFinancialTransactionsDto, {
      page: 0,
      limit: 101,
    });

    expect(errors.some((error) => error.property === 'page')).toBe(true);
    expect(errors.some((error) => error.property === 'limit')).toBe(true);
  });

  it('rejects overlong descriptions', async () => {
    const errors = await validateDto(CreateFinancialTransactionDto, {
      type: FinancialTransactionType.EXPENSE,
      categoryId: 'category_1',
      amount: 10,
      description: 'a'.repeat(161),
      transactionDate: '2026-05-22',
    });

    expect(errors.some((error) => error.property === 'description')).toBe(true);
  });

  it('rejects invalid fixed expense occurrence period', async () => {
    const errors = await validateDto(GenerateFixedExpenseOccurrenceQueryDto, {
      period: '2026-13',
    });

    expect(errors.some((error) => error.property === 'period')).toBe(true);
  });
});
