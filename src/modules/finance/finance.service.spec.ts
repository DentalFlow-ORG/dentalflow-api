import 'reflect-metadata';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FinancialTransactionSource,
  FinancialTransactionStatus,
  FinancialTransactionType,
  FixedExpenseRecurrence,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AppointmentPaymentDto } from './dto/appointment-payment.dto';
import { CreateFinancialCategoryDto } from './dto/create-financial-category.dto';
import { CreateFinancialTransactionDto } from './dto/create-financial-transaction.dto';
import { UpdateFinancialCategoryDto } from './dto/update-financial-category.dto';
import { UpdateFinancialTransactionDto } from './dto/update-financial-transaction.dto';
import { FinanceService } from './finance.service';

const CLINIC_ID = 'clinic_1';
const OTHER_CLINIC = 'clinic_2';
const USER_ID = 'user_1';
const CATEGORY_ID = 'category_1';
const TRANSACTION_ID = 'transaction_1';
const FIXED_EXPENSE_ID = 'fixed_expense_1';
const APPOINTMENT_ID = 'appointment_1';

function makeCategory(overrides: Record<string, unknown> = {}) {
  return {
    id: CATEGORY_ID,
    clinicId: CLINIC_ID,
    name: 'Materiais',
    type: FinancialTransactionType.EXPENSE,
    color: null,
    icon: null,
    isDefault: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeTransaction(overrides: Record<string, unknown> = {}) {
  return {
    id: TRANSACTION_ID,
    clinicId: CLINIC_ID,
    type: FinancialTransactionType.EXPENSE,
    source: FinancialTransactionSource.MANUAL,
    categoryId: CATEGORY_ID,
    amount: 100,
    description: 'Compra de material',
    transactionDate: new Date('2026-05-22'),
    dueDate: null,
    paidAt: null,
    status: FinancialTransactionStatus.PENDING,
    createdByUserId: USER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeFixedExpense(overrides: Record<string, unknown> = {}) {
  return {
    id: FIXED_EXPENSE_ID,
    clinicId: CLINIC_ID,
    categoryId: CATEGORY_ID,
    description: 'Aluguel mensal',
    amount: 3000,
    recurrence: FixedExpenseRecurrence.MONTHLY,
    dueDay: 5,
    startDate: new Date('2026-01-01'),
    endDate: null,
    isActive: true,
    createdByUserId: USER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeAppointment(overrides: Record<string, unknown> = {}) {
  return {
    id: APPOINTMENT_ID,
    clinicId: CLINIC_ID,
    patientName: 'Maria Oliveira',
    serviceId: 'service_1',
    profileId: 'profile_1',
    service: { id: 'service_1', name: 'Limpeza dental' },
    profile: { id: 'profile_1', name: 'Dr. Carlos' },
    ...overrides,
  };
}

describe('FinanceService — backend-owned fields', () => {
  let service: FinanceService;

  const mockPrisma = {
    financialCategory: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      createMany: jest.fn(),
      count: jest.fn(),
    },
    financialTransaction: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      count: jest.fn(),
    },
    fixedExpense: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    appointment: {
      findFirst: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FinanceService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get(FinanceService);
  });

  // ─── createCategory ────────────────────────────────────────────────────────

  describe('createCategory', () => {
    it('always writes isDefault: false in the Prisma create call', async () => {
      mockPrisma.financialCategory.create.mockResolvedValue(makeCategory());

      const dto: CreateFinancialCategoryDto = {
        name: 'Nova categoria',
        type: FinancialTransactionType.EXPENSE,
      };

      await service.createCategory(CLINIC_ID, dto);

      const call = mockPrisma.financialCategory.create.mock.calls[0][0];
      expect(call.data.isDefault).toBe(false);
    });

    it('writes isDefault: false even when attacker injects isDefault: true into the DTO', async () => {
      mockPrisma.financialCategory.create.mockResolvedValue(makeCategory());

      // Simulate an attacker constructing the object directly (bypasses class-validator)
      const dto = {
        name: 'Injecao',
        type: FinancialTransactionType.INCOME,
        isDefault: true,
      } as CreateFinancialCategoryDto;

      await service.createCategory(CLINIC_ID, dto);

      const call = mockPrisma.financialCategory.create.mock.calls[0][0];
      expect(call.data.isDefault).toBe(false);
    });
  });

  // ─── updateCategory ────────────────────────────────────────────────────────

  describe('updateCategory', () => {
    it('updates allowed fields and never includes isDefault in the Prisma data object', async () => {
      mockPrisma.financialCategory.findFirst.mockResolvedValue(makeCategory());
      mockPrisma.financialCategory.update.mockResolvedValue(
        makeCategory({ name: 'Materiais renomeado', color: '#FF0000' }),
      );

      const dto: UpdateFinancialCategoryDto = {
        name: 'Materiais renomeado',
        color: '#FF0000',
      };
      await service.updateCategory(CLINIC_ID, CATEGORY_ID, dto);

      const call = mockPrisma.financialCategory.update.mock.calls[0][0];
      expect(call.data).not.toHaveProperty('isDefault');
      expect(call.data.name).toBe('Materiais renomeado');
      expect(call.data.color).toBe('#FF0000');
    });

    it('never writes isDefault even when attacker injects it into the DTO', async () => {
      mockPrisma.financialCategory.findFirst.mockResolvedValue(makeCategory());
      mockPrisma.financialCategory.update.mockResolvedValue(makeCategory());

      const dto = {
        name: 'Injecao',
        isDefault: true,
      } as UpdateFinancialCategoryDto;

      await service.updateCategory(CLINIC_ID, CATEGORY_ID, dto);

      const call = mockPrisma.financialCategory.update.mock.calls[0][0];
      expect(call.data).not.toHaveProperty('isDefault');
    });

    it('throws NotFoundException when category belongs to a different clinic', async () => {
      mockPrisma.financialCategory.findFirst.mockResolvedValue(null);

      await expect(
        service.updateCategory(OTHER_CLINIC, CATEGORY_ID, { name: 'X' }),
      ).rejects.toThrow(NotFoundException);

      expect(mockPrisma.financialCategory.update).not.toHaveBeenCalled();
    });
  });

  // ─── deleteCategory ────────────────────────────────────────────────────────

  describe('deleteCategory', () => {
    it('throws ConflictException and does not delete when category is a default system category', async () => {
      mockPrisma.financialCategory.findFirst.mockResolvedValue(
        makeCategory({ isDefault: true }),
      );

      await expect(
        service.deleteCategory(CLINIC_ID, CATEGORY_ID),
      ).rejects.toThrow(ConflictException);

      expect(mockPrisma.financialCategory.delete).not.toHaveBeenCalled();
    });

    it('throws ConflictException when category has linked transactions', async () => {
      mockPrisma.financialCategory.findFirst.mockResolvedValue(
        makeCategory({ isDefault: false }),
      );
      mockPrisma.financialTransaction.count.mockResolvedValue(2);
      mockPrisma.fixedExpense.count.mockResolvedValue(0);

      await expect(
        service.deleteCategory(CLINIC_ID, CATEGORY_ID),
      ).rejects.toThrow(ConflictException);

      expect(mockPrisma.financialCategory.delete).not.toHaveBeenCalled();
    });

    it('throws ConflictException when category has linked fixed expenses', async () => {
      mockPrisma.financialCategory.findFirst.mockResolvedValue(
        makeCategory({ isDefault: false }),
      );
      mockPrisma.financialTransaction.count.mockResolvedValue(0);
      mockPrisma.fixedExpense.count.mockResolvedValue(1);

      await expect(
        service.deleteCategory(CLINIC_ID, CATEGORY_ID),
      ).rejects.toThrow(ConflictException);

      expect(mockPrisma.financialCategory.delete).not.toHaveBeenCalled();
    });

    it('deletes a non-default category with no linked records', async () => {
      mockPrisma.financialCategory.findFirst.mockResolvedValue(
        makeCategory({ isDefault: false }),
      );
      mockPrisma.financialTransaction.count.mockResolvedValue(0);
      mockPrisma.fixedExpense.count.mockResolvedValue(0);
      mockPrisma.financialCategory.delete.mockResolvedValue(makeCategory());

      await service.deleteCategory(CLINIC_ID, CATEGORY_ID);

      expect(mockPrisma.financialCategory.delete).toHaveBeenCalledWith({
        where: { id: CATEGORY_ID },
      });
    });
  });

  // ─── createTransaction ─────────────────────────────────────────────────────

  describe('createTransaction', () => {
    it('always writes source: MANUAL for the manual endpoint flow', async () => {
      mockPrisma.financialCategory.findFirst.mockResolvedValue(makeCategory());
      mockPrisma.financialTransaction.create.mockResolvedValue(
        makeTransaction(),
      );

      const dto: CreateFinancialTransactionDto = {
        type: FinancialTransactionType.EXPENSE,
        categoryId: CATEGORY_ID,
        amount: 75,
        description: 'Material de escritorio',
        transactionDate: '2026-05-22',
      };

      await service.createTransaction(CLINIC_ID, USER_ID, dto);

      const call = mockPrisma.financialTransaction.create.mock.calls[0][0];
      expect(call.data.source).toBe(FinancialTransactionSource.MANUAL);
    });

    it('keeps source: MANUAL even when attacker injects SERVICE_PAYMENT via the DTO', async () => {
      mockPrisma.financialCategory.findFirst.mockResolvedValue(makeCategory());
      mockPrisma.financialTransaction.create.mockResolvedValue(
        makeTransaction(),
      );

      const dto = {
        type: FinancialTransactionType.INCOME,
        categoryId: CATEGORY_ID,
        amount: 500,
        description: 'Injecao de source',
        transactionDate: '2026-05-22',
        source: FinancialTransactionSource.SERVICE_PAYMENT,
      } as CreateFinancialTransactionDto;

      await service.createTransaction(CLINIC_ID, USER_ID, dto);

      const call = mockPrisma.financialTransaction.create.mock.calls[0][0];
      expect(call.data.source).toBe(FinancialTransactionSource.MANUAL);
    });

    it('keeps source: MANUAL when attacker injects FIXED_EXPENSE via the DTO', async () => {
      mockPrisma.financialCategory.findFirst.mockResolvedValue(makeCategory());
      mockPrisma.financialTransaction.create.mockResolvedValue(
        makeTransaction(),
      );

      const dto = {
        type: FinancialTransactionType.EXPENSE,
        categoryId: CATEGORY_ID,
        amount: 1000,
        description: 'Injecao de fixed expense',
        transactionDate: '2026-05-22',
        source: FinancialTransactionSource.FIXED_EXPENSE,
      } as CreateFinancialTransactionDto;

      await service.createTransaction(CLINIC_ID, USER_ID, dto);

      const call = mockPrisma.financialTransaction.create.mock.calls[0][0];
      expect(call.data.source).toBe(FinancialTransactionSource.MANUAL);
    });
  });

  // ─── updateTransaction ─────────────────────────────────────────────────────

  describe('updateTransaction', () => {
    it('never includes source in the Prisma update data object', async () => {
      mockPrisma.financialTransaction.findFirst.mockResolvedValue(
        makeTransaction(),
      );
      mockPrisma.financialTransaction.update.mockResolvedValue(
        makeTransaction({ description: 'Atualizado' }),
      );

      const dto: UpdateFinancialTransactionDto = { description: 'Atualizado' };
      await service.updateTransaction(CLINIC_ID, TRANSACTION_ID, dto);

      const call = mockPrisma.financialTransaction.update.mock.calls[0][0];
      expect(call.data).not.toHaveProperty('source');
    });

    it('never writes source even when attacker injects SERVICE_PAYMENT into the DTO', async () => {
      mockPrisma.financialTransaction.findFirst.mockResolvedValue(
        makeTransaction(),
      );
      mockPrisma.financialTransaction.update.mockResolvedValue(
        makeTransaction(),
      );

      const dto = {
        description: 'Injecao',
        source: FinancialTransactionSource.SERVICE_PAYMENT,
      } as UpdateFinancialTransactionDto;

      await service.updateTransaction(CLINIC_ID, TRANSACTION_ID, dto);

      const call = mockPrisma.financialTransaction.update.mock.calls[0][0];
      expect(call.data).not.toHaveProperty('source');
    });

    it('throws NotFoundException and does not write when transaction belongs to a different clinic', async () => {
      mockPrisma.financialTransaction.findFirst.mockResolvedValue(null);

      await expect(
        service.updateTransaction(OTHER_CLINIC, TRANSACTION_ID, {
          description: 'X',
        }),
      ).rejects.toThrow(NotFoundException);

      expect(mockPrisma.financialTransaction.update).not.toHaveBeenCalled();
    });
  });

  // ─── generateFixedExpenseOccurrence ───────────────────────────────────────

  describe('generateFixedExpenseOccurrence', () => {
    it('writes source: FIXED_EXPENSE in the upsert create block (backend-owned)', async () => {
      mockPrisma.fixedExpense.findFirst.mockResolvedValue(makeFixedExpense());
      mockPrisma.financialTransaction.upsert.mockResolvedValue(
        makeTransaction(),
      );

      await service.generateFixedExpenseOccurrence(
        CLINIC_ID,
        USER_ID,
        FIXED_EXPENSE_ID,
        '2026-05',
      );

      const call = mockPrisma.financialTransaction.upsert.mock.calls[0][0];
      expect(call.create.source).toBe(FinancialTransactionSource.FIXED_EXPENSE);
    });

    it('throws ConflictException for an inactive fixed expense and does not upsert', async () => {
      mockPrisma.fixedExpense.findFirst.mockResolvedValue(
        makeFixedExpense({ isActive: false }),
      );

      await expect(
        service.generateFixedExpenseOccurrence(
          CLINIC_ID,
          USER_ID,
          FIXED_EXPENSE_ID,
          '2026-05',
        ),
      ).rejects.toThrow(ConflictException);

      expect(mockPrisma.financialTransaction.upsert).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when fixed expense belongs to a different clinic', async () => {
      mockPrisma.fixedExpense.findFirst.mockResolvedValue(null);

      await expect(
        service.generateFixedExpenseOccurrence(
          OTHER_CLINIC,
          USER_ID,
          FIXED_EXPENSE_ID,
          '2026-05',
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── createOrUpdateAppointmentPayment ─────────────────────────────────────

  describe('createOrUpdateAppointmentPayment', () => {
    it('writes source: SERVICE_PAYMENT in the upsert create block (backend-owned)', async () => {
      mockPrisma.appointment.findFirst.mockResolvedValue(makeAppointment());
      mockPrisma.financialCategory.findFirst.mockResolvedValue(
        makeCategory({ type: FinancialTransactionType.INCOME }),
      );
      mockPrisma.financialTransaction.upsert.mockResolvedValue(
        makeTransaction(),
      );

      const dto: AppointmentPaymentDto = {
        appointmentId: APPOINTMENT_ID,
        amount: 350,
        categoryId: CATEGORY_ID,
      };

      await service.createOrUpdateAppointmentPayment(CLINIC_ID, USER_ID, dto);

      const call = mockPrisma.financialTransaction.upsert.mock.calls[0][0];
      expect(call.create.source).toBe(
        FinancialTransactionSource.SERVICE_PAYMENT,
      );
    });

    it('throws NotFoundException when appointment does not belong to the clinic', async () => {
      mockPrisma.appointment.findFirst.mockResolvedValue(null);

      const dto: AppointmentPaymentDto = {
        appointmentId: APPOINTMENT_ID,
        amount: 200,
        categoryId: CATEGORY_ID,
      };

      await expect(
        service.createOrUpdateAppointmentPayment(OTHER_CLINIC, USER_ID, dto),
      ).rejects.toThrow(NotFoundException);

      expect(mockPrisma.financialTransaction.upsert).not.toHaveBeenCalled();
    });
  });
});
