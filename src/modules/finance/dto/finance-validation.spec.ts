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
import { CreateFinancialCategoryDto } from './create-financial-category.dto';
import { CreateFinancialTransactionDto } from './create-financial-transaction.dto';
import { CreateFixedExpenseDto } from './create-fixed-expense.dto';
import {
  GenerateFixedExpenseOccurrenceQueryDto,
  ListFinancialTransactionsDto,
} from './finance-query.dto';
import { FinanceIdParamDto } from './finance-param.dto';
import { UpdateFinancialCategoryDto } from './update-financial-category.dto';
import { UpdateFinancialTransactionDto } from './update-financial-transaction.dto';

async function validateDto<T extends object>(
  cls: new () => T,
  payload: Record<string, unknown>,
) {
  return validate(plainToInstance(cls, payload));
}

describe('finance DTO validation', () => {
  it('rejects invalid and overlong IDs', async () => {
    const invalid = await validateDto(FinanceIdParamDto, { id: '../category' });
    const overlong = await validateDto(FinanceIdParamDto, {
      id: 'a'.repeat(65),
    });
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

    expect(errors.some((error) => error.property === 'transactionDate')).toBe(
      true,
    );
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

describe('finance DTO backend-owned fields', () => {
  it('isDefault is not a declared field on CreateFinancialCategoryDto — no validation applied', async () => {
    // Before hardening, @IsBoolean() would have caught a non-boolean isDefault.
    // Now the field is undeclared: class-validator produces no error for it.
    const errors = await validateDto(CreateFinancialCategoryDto, {
      name: 'Hacked',
      type: FinancialTransactionType.INCOME,
      isDefault: 'not-a-boolean',
    });

    expect(errors.every((e) => e.property !== 'isDefault')).toBe(true);
  });

  it('isDefault is not a declared field on UpdateFinancialCategoryDto — no validation applied', async () => {
    const errors = await validateDto(UpdateFinancialCategoryDto, {
      name: 'Hacked',
      isDefault: 'not-a-boolean',
    });

    expect(errors.every((e) => e.property !== 'isDefault')).toBe(true);
  });

  it('source is not a declared field on CreateFinancialTransactionDto — no validation applied', async () => {
    // Before hardening, @IsEnum(FinancialTransactionSource) would have caught an invalid source.
    // Now the field is undeclared: class-validator produces no error for it.
    const errors = await validateDto(CreateFinancialTransactionDto, {
      type: FinancialTransactionType.EXPENSE,
      categoryId: 'category_1',
      amount: 100,
      description: 'Test',
      transactionDate: '2026-05-22',
      source: 'NOT_A_VALID_SOURCE',
    });

    expect(errors.every((e) => e.property !== 'source')).toBe(true);
  });

  it('source is not a declared field on UpdateFinancialTransactionDto — no validation applied', async () => {
    const errors = await validateDto(UpdateFinancialTransactionDto, {
      description: 'Test',
      source: 'NOT_A_VALID_SOURCE',
    });

    expect(errors.every((e) => e.property !== 'source')).toBe(true);
  });

  it('CreateFinancialCategoryDto accepts a valid payload without isDefault', async () => {
    const errors = await validateDto(CreateFinancialCategoryDto, {
      name: 'Materiais extras',
      type: FinancialTransactionType.EXPENSE,
      color: '#FF0000',
    });

    expect(errors).toHaveLength(0);
  });

  it('CreateFinancialTransactionDto accepts a valid payload without source', async () => {
    const errors = await validateDto(CreateFinancialTransactionDto, {
      type: FinancialTransactionType.INCOME,
      categoryId: 'category_1',
      amount: 150,
      description: 'Consulta',
      transactionDate: '2026-05-22',
      status: FinancialTransactionStatus.PAID,
    });

    expect(errors).toHaveLength(0);
  });
});
