import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ReportsService, EXPORT_LIMIT } from './reports.service';

const CLINIC_ID = 'clinic_1';
const OTHER_CLINIC = 'clinic_2';

// ── Mock factory helpers ──────────────────────────────────────────────────────

function makeClinic(overrides: Record<string, unknown> = {}) {
  return { id: CLINIC_ID, name: 'Clínica Teste', ...overrides };
}

function makeStockProduct(overrides: Record<string, unknown> = {}) {
  return {
    isActive: true,
    currentQuantity: new Prisma.Decimal(10),
    minQuantity: new Prisma.Decimal(2),
    expiresAt: null,
    ...overrides,
  };
}

// ── Mock PrismaService ────────────────────────────────────────────────────────

const mockPrisma = {
  financialTransaction: {
    findMany: jest.fn(),
    count: jest.fn(),
  },
  appointment: {
    findMany: jest.fn(),
    count: jest.fn(),
  },
  stockProduct: {
    findMany: jest.fn(),
  },
  serviceInvoice: {
    findMany: jest.fn(),
    count: jest.fn(),
  },
  clinic: {
    findUniqueOrThrow: jest.fn(),
  },
};

// ── Setup ─────────────────────────────────────────────────────────────────────

describe('ReportsService', () => {
  let service: ReportsService;

  beforeEach(async () => {
    jest.clearAllMocks();

    mockPrisma.clinic.findUniqueOrThrow.mockResolvedValue(makeClinic());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get(ReportsService);
  });

  // ── previewFinance ────────────────────────────────────────────────────────

  describe('previewFinance', () => {
    it('returns correct reportType and reportTitle', async () => {
      mockPrisma.financialTransaction.count.mockResolvedValue(3);
      const result = await service.previewFinance(CLINIC_ID, {});
      expect(result.reportType).toBe('finance');
      expect(result.reportTitle).toBe('Relatório financeiro');
    });

    it('returns clinic name from database', async () => {
      mockPrisma.financialTransaction.count.mockResolvedValue(0);
      mockPrisma.clinic.findUniqueOrThrow.mockResolvedValue({ name: 'Odonto Center' });
      const result = await service.previewFinance(CLINIC_ID, {});
      expect(result.clinic.name).toBe('Odonto Center');
    });

    it('returns document: null (no CNPJ in Clinic model)', async () => {
      mockPrisma.financialTransaction.count.mockResolvedValue(0);
      const result = await service.previewFinance(CLINIC_ID, {});
      expect(result.clinic.document).toBeNull();
    });

    it('returns correct recordCount', async () => {
      mockPrisma.financialTransaction.count.mockResolvedValue(42);
      const result = await service.previewFinance(CLINIC_ID, {});
      expect(result.recordCount).toBe(42);
    });

    it('sets empty: true when recordCount is 0', async () => {
      mockPrisma.financialTransaction.count.mockResolvedValue(0);
      const result = await service.previewFinance(CLINIC_ID, {});
      expect(result.empty).toBe(true);
    });

    it('sets empty: false when recordCount > 0', async () => {
      mockPrisma.financialTransaction.count.mockResolvedValue(5);
      const result = await service.previewFinance(CLINIC_ID, {});
      expect(result.empty).toBe(false);
    });

    it('sets isTruncated: true when recordCount > EXPORT_LIMIT', async () => {
      mockPrisma.financialTransaction.count.mockResolvedValue(EXPORT_LIMIT + 1);
      const result = await service.previewFinance(CLINIC_ID, {});
      expect(result.isTruncated).toBe(true);
    });

    it('sets isTruncated: false when recordCount <= EXPORT_LIMIT', async () => {
      mockPrisma.financialTransaction.count.mockResolvedValue(EXPORT_LIMIT);
      const result = await service.previewFinance(CLINIC_ID, {});
      expect(result.isTruncated).toBe(false);
    });

    it('returns maxRecords: 5000', async () => {
      mockPrisma.financialTransaction.count.mockResolvedValue(0);
      const result = await service.previewFinance(CLINIC_ID, {});
      expect(result.maxRecords).toBe(5000);
    });

    it('returns exportFormat: CSV', async () => {
      mockPrisma.financialTransaction.count.mockResolvedValue(0);
      const result = await service.previewFinance(CLINIC_ID, {});
      expect(result.exportFormat).toBe('CSV');
    });

    it('includes type filter label when type is provided', async () => {
      mockPrisma.financialTransaction.count.mockResolvedValue(0);
      const result = await service.previewFinance(CLINIC_ID, { type: 'INCOME' } as any);
      expect(result.filters).toContainEqual({ label: 'Tipo', value: 'Receita' });
    });

    it('includes status filter label when status is provided', async () => {
      mockPrisma.financialTransaction.count.mockResolvedValue(0);
      const result = await service.previewFinance(CLINIC_ID, { status: 'PAID' } as any);
      expect(result.filters).toContainEqual({ label: 'Status', value: 'Pago' });
    });

    it('includes period when startDate and endDate are provided', async () => {
      mockPrisma.financialTransaction.count.mockResolvedValue(0);
      const result = await service.previewFinance(CLINIC_ID, {
        startDate: '2026-05-01',
        endDate: '2026-05-31',
      });
      expect(result.period).not.toBeNull();
      expect(result.period?.startDate).toBe('2026-05-01');
      expect(result.period?.endDate).toBe('2026-05-31');
      expect(result.period?.label).toBe('01/05/2026 até 31/05/2026');
    });

    it('returns period: null when no dates provided', async () => {
      mockPrisma.financialTransaction.count.mockResolvedValue(0);
      const result = await service.previewFinance(CLINIC_ID, {});
      expect(result.period).toBeNull();
    });

    it('uses same clinicId scoping as export (passes clinicId to where)', async () => {
      mockPrisma.financialTransaction.count.mockResolvedValue(0);
      await service.previewFinance(CLINIC_ID, {});
      expect(mockPrisma.financialTransaction.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ clinicId: CLINIC_ID }) }),
      );
    });

    it('does not expose full row data (no rows in response)', async () => {
      mockPrisma.financialTransaction.count.mockResolvedValue(5);
      const result = await service.previewFinance(CLINIC_ID, {});
      expect(result).not.toHaveProperty('rows');
      expect(result).not.toHaveProperty('data');
      expect(result).not.toHaveProperty('transactions');
    });

    it('throws BadRequestException for invalid date range', async () => {
      await expect(
        service.previewFinance(CLINIC_ID, {
          startDate: '2026-06-01',
          endDate: '2026-01-01',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('generates a generatedAt ISO timestamp', async () => {
      mockPrisma.financialTransaction.count.mockResolvedValue(0);
      const result = await service.previewFinance(CLINIC_ID, {});
      expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  // ── previewAppointments ───────────────────────────────────────────────────

  describe('previewAppointments', () => {
    it('returns correct reportType and reportTitle', async () => {
      mockPrisma.appointment.count.mockResolvedValue(0);
      const result = await service.previewAppointments(CLINIC_ID, {});
      expect(result.reportType).toBe('appointments');
      expect(result.reportTitle).toBe('Relatório de agendamentos');
    });

    it('returns correct recordCount', async () => {
      mockPrisma.appointment.count.mockResolvedValue(17);
      const result = await service.previewAppointments(CLINIC_ID, {});
      expect(result.recordCount).toBe(17);
    });

    it('sets empty: true when count is 0', async () => {
      mockPrisma.appointment.count.mockResolvedValue(0);
      const result = await service.previewAppointments(CLINIC_ID, {});
      expect(result.empty).toBe(true);
    });

    it('sets isTruncated: true when count exceeds EXPORT_LIMIT', async () => {
      mockPrisma.appointment.count.mockResolvedValue(6000);
      const result = await service.previewAppointments(CLINIC_ID, {});
      expect(result.isTruncated).toBe(true);
    });

    it('includes status filter label', async () => {
      mockPrisma.appointment.count.mockResolvedValue(0);
      const result = await service.previewAppointments(CLINIC_ID, { status: 'CONFIRMED' } as any);
      expect(result.filters).toContainEqual({ label: 'Status', value: 'Confirmado' });
    });

    it('scopes count to clinicId', async () => {
      mockPrisma.appointment.count.mockResolvedValue(0);
      await service.previewAppointments(CLINIC_ID, {});
      expect(mockPrisma.appointment.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ clinicId: CLINIC_ID }) }),
      );
    });

    it('does not expose full appointment rows', async () => {
      mockPrisma.appointment.count.mockResolvedValue(3);
      const result = await service.previewAppointments(CLINIC_ID, {});
      expect(result).not.toHaveProperty('rows');
      expect(result).not.toHaveProperty('appointments');
    });
  });

  // ── previewInventory ──────────────────────────────────────────────────────

  describe('previewInventory', () => {
    it('returns correct reportType and reportTitle', async () => {
      mockPrisma.stockProduct.findMany.mockResolvedValue([]);
      const result = await service.previewInventory(CLINIC_ID, {});
      expect(result.reportType).toBe('inventory');
      expect(result.reportTitle).toBe('Relatório de estoque');
    });

    it('returns exact recordCount after in-memory status filter', async () => {
      mockPrisma.stockProduct.findMany.mockResolvedValue([
        makeStockProduct({ isActive: true, currentQuantity: new Prisma.Decimal(0) }),  // EMPTY
        makeStockProduct({ isActive: true, currentQuantity: new Prisma.Decimal(5) }), // ACTIVE
        makeStockProduct({ isActive: false }),                                          // INACTIVE
      ]);
      // No status filter — all 3 count
      const result = await service.previewInventory(CLINIC_ID, {});
      expect(result.recordCount).toBe(3);
    });

    it('filters count by status when status is provided', async () => {
      mockPrisma.stockProduct.findMany.mockResolvedValue([
        makeStockProduct({ isActive: true, currentQuantity: new Prisma.Decimal(0) }),  // EMPTY
        makeStockProduct({ isActive: true, currentQuantity: new Prisma.Decimal(5) }), // ACTIVE
        makeStockProduct({ isActive: false }),                                          // INACTIVE
      ]);
      const result = await service.previewInventory(CLINIC_ID, { status: 'EMPTY' });
      expect(result.recordCount).toBe(1);
    });

    it('sets empty: true when no products match', async () => {
      mockPrisma.stockProduct.findMany.mockResolvedValue([]);
      const result = await service.previewInventory(CLINIC_ID, {});
      expect(result.empty).toBe(true);
    });

    it('sets isTruncated: true when count exceeds EXPORT_LIMIT', async () => {
      const manyProducts = Array.from({ length: EXPORT_LIMIT + 1 }, () =>
        makeStockProduct(),
      );
      mockPrisma.stockProduct.findMany.mockResolvedValue(manyProducts);
      const result = await service.previewInventory(CLINIC_ID, {});
      expect(result.isTruncated).toBe(true);
    });

    it('fetches products without take cap (to get exact count)', async () => {
      mockPrisma.stockProduct.findMany.mockResolvedValue([]);
      await service.previewInventory(CLINIC_ID, {});
      const call = mockPrisma.stockProduct.findMany.mock.calls[0][0] as any;
      expect(call.take).toBeUndefined();
    });

    it('scopes product fetch to clinicId', async () => {
      mockPrisma.stockProduct.findMany.mockResolvedValue([]);
      await service.previewInventory(CLINIC_ID, {});
      expect(mockPrisma.stockProduct.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ clinicId: CLINIC_ID }) }),
      );
    });

    it('returns period: null (inventory has no date range)', async () => {
      mockPrisma.stockProduct.findMany.mockResolvedValue([]);
      const result = await service.previewInventory(CLINIC_ID, {});
      expect(result.period).toBeNull();
    });

    it('does not expose product row data', async () => {
      mockPrisma.stockProduct.findMany.mockResolvedValue([makeStockProduct()]);
      const result = await service.previewInventory(CLINIC_ID, {});
      expect(result).not.toHaveProperty('rows');
      expect(result).not.toHaveProperty('products');
    });
  });

  // ── previewInvoices ───────────────────────────────────────────────────────

  describe('previewInvoices', () => {
    it('returns correct reportType and reportTitle', async () => {
      mockPrisma.serviceInvoice.count.mockResolvedValue(0);
      const result = await service.previewInvoices(CLINIC_ID, {});
      expect(result.reportType).toBe('invoices');
      expect(result.reportTitle).toBe('Relatório de notas fiscais');
    });

    it('returns correct recordCount', async () => {
      mockPrisma.serviceInvoice.count.mockResolvedValue(8);
      const result = await service.previewInvoices(CLINIC_ID, {});
      expect(result.recordCount).toBe(8);
    });

    it('sets empty: true when count is 0', async () => {
      mockPrisma.serviceInvoice.count.mockResolvedValue(0);
      const result = await service.previewInvoices(CLINIC_ID, {});
      expect(result.empty).toBe(true);
    });

    it('sets isTruncated: true when count exceeds EXPORT_LIMIT', async () => {
      mockPrisma.serviceInvoice.count.mockResolvedValue(9999);
      const result = await service.previewInvoices(CLINIC_ID, {});
      expect(result.isTruncated).toBe(true);
    });

    it('includes status filter label for ISSUED', async () => {
      mockPrisma.serviceInvoice.count.mockResolvedValue(0);
      const result = await service.previewInvoices(CLINIC_ID, { status: 'ISSUED' } as any);
      expect(result.filters).toContainEqual({ label: 'Status', value: 'Emitido' });
    });

    it('includes period when dates are provided', async () => {
      mockPrisma.serviceInvoice.count.mockResolvedValue(0);
      const result = await service.previewInvoices(CLINIC_ID, {
        startDate: '2026-01-01',
        endDate: '2026-03-31',
      });
      expect(result.period?.label).toBe('01/01/2026 até 31/03/2026');
    });

    it('scopes count to clinicId', async () => {
      mockPrisma.serviceInvoice.count.mockResolvedValue(0);
      await service.previewInvoices(CLINIC_ID, {});
      expect(mockPrisma.serviceInvoice.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ clinicId: CLINIC_ID }) }),
      );
    });

    it('does not expose invoice row data', async () => {
      mockPrisma.serviceInvoice.count.mockResolvedValue(2);
      const result = await service.previewInvoices(CLINIC_ID, {});
      expect(result).not.toHaveProperty('rows');
      expect(result).not.toHaveProperty('invoices');
    });
  });
});
