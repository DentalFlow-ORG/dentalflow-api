import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ReportsService, EXPORT_LIMIT } from './reports.service';

/**
 * CSV report exports.
 *
 * `reports.service.spec.ts` covers the preview endpoints — record counts and
 * filter descriptions. This suite covers the exports themselves: the bytes a
 * clinic downloads and opens in Excel.
 *
 * The security-relevant part is formula injection. A patient name beginning
 * with `=`, `+`, `-` or `@` is executed as a formula by Excel and Google
 * Sheets when the file is opened, which is a remote-code-execution vector
 * through data a stranger can supply by booking an appointment. Every exported
 * cell must be neutralised, and those tests are the reason this file exists.
 *
 * Everything else is correctness a broken export fails silently on: the BOM
 * that makes accented Portuguese render, the semicolon separator Brazilian
 * Excel expects, comma decimals, and the row cap.
 */

const CLINIC = 'clinic-1';

function createPrisma() {
  return {
    financialTransaction: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    appointment: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    stockProduct: { findMany: jest.fn().mockResolvedValue([]) },
    serviceInvoice: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    clinic: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ name: 'Clínica Teste' }),
    },
  };
}

function financeRow(overrides: Record<string, unknown> = {}) {
  return {
    transactionDate: new Date('2026-06-10T00:00:00.000Z'),
    type: 'INCOME',
    status: 'PAID',
    description: 'Consulta',
    amount: new Prisma.Decimal('150.50'),
    category: { name: 'Serviços' },
    service: { name: 'Limpeza' },
    profile: { displayName: 'Dra. Ana' },
    ...overrides,
  };
}

function appointmentRow(overrides: Record<string, unknown> = {}) {
  return {
    appointmentDate: new Date('2026-06-10T00:00:00.000Z'),
    startTime: new Date('1970-01-01T09:00:00.000Z'),
    endTime: new Date('1970-01-01T10:00:00.000Z'),
    patientName: 'Maria Silva',
    patientPhone: '11999998888',
    patientEmail: 'maria@example.test',
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    estimatedAmountCents: 15000,
    paidAmountCents: 15000,
    notes: null,
    profile: { displayName: 'Dra. Ana' },
    service: { name: 'Limpeza' },
    ...overrides,
  };
}

describe('ReportsService — CSV exports', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let service: ReportsService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
    prisma = createPrisma();
    service = new ReportsService(prisma as never);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** The data rows of a CSV, without the header. */
  function dataRows(csv: string): string[] {
    return csv
      .replace(/^\uFEFF/, '')
      .split('\r\n')
      .slice(1);
  }

  /** Splits one CSV line into fields, honouring quoting. */
  function splitCsvLine(line: string): string[] {
    const fields: string[] = [];
    let current = '';
    let quoted = false;

    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (quoted) {
        if (char === '"' && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else if (char === '"') {
          quoted = false;
        } else {
          current += char;
        }
      } else if (char === '"') {
        quoted = true;
      } else if (char === ';') {
        fields.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    fields.push(current);
    return fields;
  }

  /** Every field of every data row, as a spreadsheet would parse them. */
  function parseFields(csv: string): string[] {
    return dataRows(csv).flatMap(splitCsvLine);
  }

  // ── Formula injection ──────────────────────────────────────────────────────

  describe('formula injection', () => {
    it.each([
      ['equals', '=cmd|calc'],
      ['plus', '+1+1'],
      ['minus', '-1+1'],
      ['at', '@SUM(A1)'],
      ['tab', '\tinjected'],
      ['carriage return', '\rinjected'],
    ])(
      'neutralises a %s-prefixed value from patient data',
      async (_name, hostile) => {
        // A patient can set this simply by booking under that name.
        prisma.appointment.findMany.mockResolvedValue([
          appointmentRow({ patientName: hostile }),
        ]);

        const csv = await service.exportAppointments(CLINIC, {} as never);

        // Every surviving cell must be inert: no field may begin with a
        // character a spreadsheet treats as the start of a formula.
        for (const field of parseFields(csv)) {
          expect(field).not.toMatch(/^[=+\-@\t\r]/);
        }
      },
    );

    it('cannot be bypassed by embedding a separator in the hostile value', async () => {
      // REGRESSION: csvValue returned as soon as it had added the apostrophe,
      // skipping the quoting below it. A value carrying the separator then
      // split into two fields and only the first was neutralised — the second
      // reached the spreadsheet as a live formula.
      prisma.appointment.findMany.mockResolvedValue([
        appointmentRow({ patientName: '=a;=cmd|calc' }),
      ]);

      const csv = await service.exportAppointments(CLINIC, {} as never);

      for (const field of parseFields(csv)) {
        expect(field).not.toMatch(/^[=+\-@\t\r]/);
      }
    });

    it('keeps a hostile value in one cell rather than shifting the columns', async () => {
      prisma.appointment.findMany.mockResolvedValue([
        appointmentRow({ patientName: '=a;b' }),
      ]);

      const csv = await service.exportAppointments(CLINIC, {} as never);
      const lines = csv.replace(/^\uFEFF/, '').split('\r\n');

      expect(splitCsvLine(lines[1])).toHaveLength(
        splitCsvLine(lines[0]).length,
      );
    });

    it('neutralises a hostile value in a finance description', async () => {
      prisma.financialTransaction.findMany.mockResolvedValue([
        financeRow({ description: '=HYPERLINK("http://evil","click")' }),
      ]);

      const csv = await service.exportFinance(CLINIC, {} as never);

      expect(csv).toContain(`"'=HYPERLINK`);
    });

    it('leaves an ordinary value untouched', async () => {
      prisma.appointment.findMany.mockResolvedValue([
        appointmentRow({ patientName: 'Maria Silva' }),
      ]);

      const csv = await service.exportAppointments(CLINIC, {} as never);
      expect(csv).toContain('Maria Silva');
      expect(csv).not.toContain(`'Maria Silva`);
    });
  });

  // ── CSV mechanics ──────────────────────────────────────────────────────────

  describe('CSV format', () => {
    it('starts with a BOM so Excel renders accented Portuguese', async () => {
      const csv = await service.exportFinance(CLINIC, {} as never);
      expect(csv.charCodeAt(0)).toBe(0xfeff);
    });

    it('separates with semicolons, as Brazilian Excel expects', async () => {
      const csv = await service.exportFinance(CLINIC, {} as never);
      const header = csv.replace(/^\uFEFF/, '').split('\r\n')[0];

      expect(header.split(';').length).toBeGreaterThan(1);
      expect(header).toContain('Data;Tipo;Status');
    });

    it('uses CRLF line endings', async () => {
      prisma.financialTransaction.findMany.mockResolvedValue([financeRow()]);

      const csv = await service.exportFinance(CLINIC, {} as never);
      expect(csv).toContain('\r\n');
    });

    it('quotes a value containing the separator', async () => {
      prisma.financialTransaction.findMany.mockResolvedValue([
        financeRow({ description: 'Consulta; retorno' }),
      ]);

      const csv = await service.exportFinance(CLINIC, {} as never);
      expect(csv).toContain('"Consulta; retorno"');
    });

    it('doubles an embedded quote', async () => {
      prisma.financialTransaction.findMany.mockResolvedValue([
        financeRow({ description: 'Consulta "urgente"' }),
      ]);

      const csv = await service.exportFinance(CLINIC, {} as never);
      expect(csv).toContain('"Consulta ""urgente"""');
    });

    it('quotes a value containing a newline', async () => {
      prisma.financialTransaction.findMany.mockResolvedValue([
        financeRow({ description: 'Linha 1\nLinha 2' }),
      ]);

      const csv = await service.exportFinance(CLINIC, {} as never);
      expect(csv).toContain('"Linha 1\nLinha 2"');
    });

    it('writes an empty cell for a null value rather than "null"', async () => {
      prisma.financialTransaction.findMany.mockResolvedValue([
        financeRow({
          description: null,
          category: null,
          service: null,
          profile: null,
        }),
      ]);

      const csv = await service.exportFinance(CLINIC, {} as never);
      expect(csv).not.toContain('null');
      expect(csv).not.toContain('undefined');
    });

    it('emits only a header when there is nothing to export', async () => {
      const csv = await service.exportFinance(CLINIC, {} as never);
      expect(dataRows(csv)).toEqual([]);
    });
  });

  // ── Brazilian formatting ───────────────────────────────────────────────────

  describe('Brazilian formatting', () => {
    it('writes money with a comma decimal separator', async () => {
      prisma.financialTransaction.findMany.mockResolvedValue([
        financeRow({ amount: new Prisma.Decimal('1234.50') }),
      ]);

      const csv = await service.exportFinance(CLINIC, {} as never);
      expect(csv).toContain('1234,50');
    });

    it('always writes two decimal places', async () => {
      prisma.financialTransaction.findMany.mockResolvedValue([
        financeRow({ amount: new Prisma.Decimal('100') }),
      ]);

      const csv = await service.exportFinance(CLINIC, {} as never);
      expect(csv).toContain('100,00');
    });

    it('renders a calendar date as stored, without shifting it a day back', async () => {
      // REGRESSION: transactionDate is a DATE column, which Prisma returns as
      // UTC midnight. Formatting that in America/Sao_Paulo (UTC-3) produced
      // the previous day, so every date in every export was off by one.
      prisma.financialTransaction.findMany.mockResolvedValue([
        financeRow({ transactionDate: new Date('2026-06-10T00:00:00.000Z') }),
      ]);

      const csv = await service.exportFinance(CLINIC, {} as never);
      expect(csv).toContain('10/06/2026');
      expect(csv).not.toContain('09/06/2026');
    });

    it('renders an appointment date as stored', async () => {
      prisma.appointment.findMany.mockResolvedValue([
        appointmentRow({
          appointmentDate: new Date('2026-06-10T00:00:00.000Z'),
        }),
      ]);

      const csv = await service.exportAppointments(CLINIC, {} as never);
      expect(csv).toContain('10/06/2026');
    });

    it('renders a product expiry date as stored', async () => {
      prisma.stockProduct.findMany.mockResolvedValue([
        {
          name: 'Anestésico',
          isActive: true,
          currentQuantity: new Prisma.Decimal(10),
          minQuantity: new Prisma.Decimal(2),
          expiresAt: new Date('2027-01-01T00:00:00.000Z'),
          unit: 'CX',
          supplier: null,
          category: null,
        },
      ]);

      const csv = await service.exportInventory(CLINIC, {} as never);
      expect(csv).toContain('01/01/2027');
    });

    it('renders a real timestamp in Brazil time, where the zone genuinely applies', async () => {
      // simulatedIssueDate is a timestamp rather than a DATE column, so the
      // moment must be shown in the clinic's own timezone.
      prisma.serviceInvoice.findMany.mockResolvedValue([
        {
          competenceDate: new Date('2026-06-10T00:00:00.000Z'),
          simulatedIssueDate: new Date('2026-06-11T01:00:00.000Z'),
          issueDate: null,
          status: 'SIMULATED',
          customerName: 'Maria',
          customerDocument: null,
          serviceDescription: 'Limpeza',
          amountCents: 10000,
          issAmountCents: null,
          invoiceNumber: null,
          isLegalDocument: false,
          environment: 'LOCAL',
        },
      ]);

      const csv = await service.exportInvoices(CLINIC, {} as never);

      // 01:00 UTC on the 11th is 22:00 on the 10th in Brazil.
      expect(csv).toContain('10/06/2026');
    });

    it('translates status and type into Portuguese labels', async () => {
      prisma.financialTransaction.findMany.mockResolvedValue([
        financeRow({ type: 'INCOME', status: 'PAID' }),
      ]);

      const csv = await service.exportFinance(CLINIC, {} as never);
      expect(csv).not.toContain('INCOME');
      expect(csv).not.toContain(';PAID;');
    });
  });

  // ── Row cap ────────────────────────────────────────────────────────────────

  describe('row cap', () => {
    it('caps the finance export', async () => {
      await service.exportFinance(CLINIC, {} as never);

      expect(prisma.financialTransaction.findMany.mock.calls[0][0].take).toBe(
        EXPORT_LIMIT,
      );
    });

    it('caps the appointments export', async () => {
      await service.exportAppointments(CLINIC, {} as never);

      expect(prisma.appointment.findMany.mock.calls[0][0].take).toBe(
        EXPORT_LIMIT,
      );
    });

    it('caps the inventory export', async () => {
      await service.exportInventory(CLINIC, {} as never);

      expect(prisma.stockProduct.findMany.mock.calls[0][0].take).toBe(
        EXPORT_LIMIT,
      );
    });

    it('caps the invoices export', async () => {
      await service.exportInvoices(CLINIC, {} as never);

      expect(prisma.serviceInvoice.findMany.mock.calls[0][0].take).toBe(
        EXPORT_LIMIT,
      );
    });
  });

  // ── Tenant scoping ─────────────────────────────────────────────────────────

  describe('tenant scoping', () => {
    it.each([
      [
        'finance',
        () => service.exportFinance(CLINIC, {} as never),
        'financialTransaction',
      ],
      [
        'appointments',
        () => service.exportAppointments(CLINIC, {} as never),
        'appointment',
      ],
      [
        'inventory',
        () => service.exportInventory(CLINIC, {} as never),
        'stockProduct',
      ],
      [
        'invoices',
        () => service.exportInvoices(CLINIC, {} as never),
        'serviceInvoice',
      ],
    ])('scopes the %s export to the clinic', async (_name, call, model) => {
      await call();

      const where = (
        prisma as unknown as Record<string, { findMany: jest.Mock }>
      )[model].findMany.mock.calls[0][0].where;
      expect(where.clinicId).toBe(CLINIC);
    });
  });

  // ── Date range validation ──────────────────────────────────────────────────

  describe('date range validation', () => {
    it('refuses a finance range that ends before it starts', async () => {
      await expect(
        service.exportFinance(CLINIC, {
          startDate: '2026-06-30',
          endDate: '2026-06-01',
        } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses a future end date for a finance report', async () => {
      // Money cannot have moved in the future.
      await expect(
        service.exportFinance(CLINIC, { endDate: '2030-01-01' } as never),
      ).rejects.toThrow(/futura/);
    });

    it('allows a future end date for an appointments report', async () => {
      // The agenda is legitimately forward-looking.
      await expect(
        service.exportAppointments(CLINIC, { endDate: '2030-01-01' } as never),
      ).resolves.toBeDefined();
    });

    it('refuses a range longer than twelve months', async () => {
      await expect(
        service.exportFinance(CLINIC, {
          startDate: '2024-01-01',
          endDate: '2025-06-01',
        } as never),
      ).rejects.toThrow(/12 meses/);
    });

    it('applies the range to the query when valid', async () => {
      // Frozen "today" is 2026-06-15, so the range must not run past it.
      await service.exportFinance(CLINIC, {
        startDate: '2026-06-01',
        endDate: '2026-06-10',
      } as never);

      const where = prisma.financialTransaction.findMany.mock.calls[0][0].where;
      expect(where.transactionDate.gte).toBeInstanceOf(Date);
      expect(where.transactionDate.lt).toBeInstanceOf(Date);
    });

    it('omits the date filter when no range is given', async () => {
      await service.exportFinance(CLINIC, {} as never);

      expect(
        prisma.financialTransaction.findMany.mock.calls[0][0].where,
      ).not.toHaveProperty('transactionDate');
    });
  });

  // ── Filters ────────────────────────────────────────────────────────────────

  describe('filters', () => {
    it('filters finance by type, status and category', async () => {
      await service.exportFinance(CLINIC, {
        type: 'INCOME',
        status: 'PAID',
        categoryId: 'cat-1',
      } as never);

      expect(
        prisma.financialTransaction.findMany.mock.calls[0][0].where,
      ).toMatchObject({
        type: 'INCOME',
        status: 'PAID',
        categoryId: 'cat-1',
      });
    });

    it('filters inventory by category', async () => {
      await service.exportInventory(CLINIC, { categoryId: 'cat-1' } as never);

      expect(
        prisma.stockProduct.findMany.mock.calls[0][0].where.categoryId,
      ).toBe('cat-1');
    });

    it('filters inventory by derived status after loading', async () => {
      // Status is computed rather than stored, so it cannot be a SQL filter.
      prisma.stockProduct.findMany.mockResolvedValue([
        {
          name: 'Vazio',
          isActive: true,
          currentQuantity: new Prisma.Decimal(0),
          minQuantity: new Prisma.Decimal(5),
          expiresAt: null,
          unit: 'CX',
          supplier: null,
          category: { name: 'Descartáveis' },
        },
        {
          name: 'Cheio',
          isActive: true,
          currentQuantity: new Prisma.Decimal(100),
          minQuantity: new Prisma.Decimal(5),
          expiresAt: null,
          unit: 'CX',
          supplier: null,
          category: { name: 'Descartáveis' },
        },
      ]);

      const csv = await service.exportInventory(CLINIC, {
        status: 'EMPTY',
      } as never);

      expect(csv).toContain('Vazio');
      expect(csv).not.toContain('Cheio');
    });

    it('exports every product when no status filter is given', async () => {
      prisma.stockProduct.findMany.mockResolvedValue([
        {
          name: 'Produto',
          isActive: true,
          currentQuantity: new Prisma.Decimal(100),
          minQuantity: new Prisma.Decimal(5),
          expiresAt: null,
          unit: 'CX',
          supplier: null,
          category: null,
        },
      ]);

      const csv = await service.exportInventory(CLINIC, {} as never);
      expect(dataRows(csv)).toHaveLength(1);
    });
  });

  // ── Ordering ───────────────────────────────────────────────────────────────

  describe('ordering', () => {
    it('orders finance newest first, with a tie-break', async () => {
      await service.exportFinance(CLINIC, {} as never);

      expect(
        prisma.financialTransaction.findMany.mock.calls[0][0].orderBy,
      ).toEqual([{ transactionDate: 'desc' }, { createdAt: 'desc' }]);
    });

    it('lists active inventory before inactive, then alphabetically', async () => {
      await service.exportInventory(CLINIC, {} as never);

      expect(prisma.stockProduct.findMany.mock.calls[0][0].orderBy).toEqual([
        { isActive: 'desc' },
        { name: 'asc' },
      ]);
    });
  });
});
