import { Prisma } from '@prisma/client';

import { ReportsService } from './reports.service';

/**
 * What a CSV export puts in a cell when the value is missing or unusable.
 *
 * Every formatter in the exporter has a null and an unparseable branch, and
 * none of them was exercised. They all exist for the same reason: a clinic
 * opening the file in Excel must see an empty cell, not `Invalid Date`,
 * `NaN`, `null` or `undefined`. A spreadsheet full of those is a spreadsheet
 * nobody can total.
 *
 * The period label is here too. It appears at the top of a printed report and
 * has to read correctly with either bound missing, or neither.
 */

const CLINIC = 'clinic-1';

function createPrisma() {
  return {
    financialTransaction: { findMany: jest.fn().mockResolvedValue([]) },
    appointment: { findMany: jest.fn().mockResolvedValue([]) },
    stockProduct: { findMany: jest.fn().mockResolvedValue([]) },
    stockMovement: { findMany: jest.fn().mockResolvedValue([]) },
    serviceInvoice: { findMany: jest.fn().mockResolvedValue([]) },
    clinic: { findUnique: jest.fn().mockResolvedValue({ name: 'Clínica' }) },
  };
}

/** Splits a CSV line into fields, honouring quoting. */
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

function dataFields(csv: string): string[] {
  const rows = csv
    .replace(/^\uFEFF/, '')
    .split('\r\n')
    .slice(1);
  return rows.filter((row) => row.length > 0).flatMap(splitCsvLine);
}

describe('ReportsService — empty and unusable values', () => {
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

  /** Nothing a formatter produced may read as a JavaScript accident. */
  function expectNoJunk(csv: string) {
    for (const field of dataFields(csv)) {
      expect(field).not.toMatch(/Invalid Date/);
      expect(field).not.toMatch(/^NaN$/);
      expect(field).not.toMatch(/^null$/);
      expect(field).not.toMatch(/^undefined$/);
    }
  }

  describe('the finance export', () => {
    it('leaves a cell blank rather than printing a null', async () => {
      prisma.financialTransaction.findMany.mockResolvedValue([
        {
          transactionDate: null,
          paidAt: null,
          dueDate: null,
          description: 'Sem data',
          amount: null,
          type: 'EXPENSE',
          status: 'PENDING',
          category: null,
          service: null,
          profile: null,
        },
      ]);

      const csv = await service.exportFinance(CLINIC, {} as never);

      expectNoJunk(csv);
    });

    it('leaves a cell blank for a date it cannot parse', async () => {
      prisma.financialTransaction.findMany.mockResolvedValue([
        {
          transactionDate: 'not-a-date',
          paidAt: 'also-not',
          description: 'Data ruim',
          amount: new Prisma.Decimal(10),
          type: 'INCOME',
          status: 'PAID',
          category: null,
          service: null,
          profile: null,
        },
      ]);

      const csv = await service.exportFinance(CLINIC, {} as never);

      expectNoJunk(csv);
    });
  });

  describe('the appointments export', () => {
    it('copes with every optional field absent', async () => {
      prisma.appointment.findMany.mockResolvedValue([
        {
          appointmentDate: null,
          startTime: null,
          endTime: null,
          patientName: 'Maria',
          patientEmail: null,
          patientPhone: null,
          status: 'PENDING',
          paymentStatus: null,
          estimatedAmountCents: null,
          paidAmountCents: null,
          // `profileId` is non-null in the schema, so the relation is always
          // present. A mock returning null here would manufacture a failure
          // the real client cannot produce.
          profile: { displayName: 'Dra. Ana' },
          service: null,
        },
      ]);

      const csv = await service.exportAppointments(CLINIC, {} as never);

      expectNoJunk(csv);
    });
  });

  describe('the inventory export', () => {
    it('copes with an unpriced, undated product', async () => {
      prisma.stockProduct.findMany.mockResolvedValue([
        {
          name: 'Gaze',
          isActive: true,
          currentQuantity: new Prisma.Decimal(5),
          minQuantity: new Prisma.Decimal(1),
          expiresAt: null,
          unit: null,
          supplier: null,
          purchasePrice: null,
          category: null,
        },
      ]);

      const csv = await service.exportInventory(CLINIC, {} as never);

      expectNoJunk(csv);
    });

    it('prints a quantity that is genuinely zero, rather than blanking it', async () => {
      prisma.stockProduct.findMany.mockResolvedValue([
        {
          name: 'Gaze',
          isActive: true,
          currentQuantity: new Prisma.Decimal(0),
          minQuantity: new Prisma.Decimal(0),
          expiresAt: null,
          unit: 'CX',
          supplier: null,
          purchasePrice: null,
          category: null,
        },
      ]);

      const csv = await service.exportInventory(CLINIC, {} as never);

      // Zero is a fact about the stockroom; an empty cell is a missing one.
      expect(dataFields(csv)).toContain('0,000');
    });
  });

  describe('the invoices export', () => {
    it('copes with an invoice carrying no issued document', async () => {
      prisma.serviceInvoice.findMany.mockResolvedValue([
        {
          competenceDate: null,
          simulatedIssueDate: null,
          issueDate: null,
          status: 'DRAFT',
          customerName: 'Maria',
          customerDocument: null,
          serviceDescription: 'Limpeza',
          amountCents: null,
          issAmountCents: null,
          invoiceNumber: null,
          isLegalDocument: false,
          environment: 'LOCAL',
        },
      ]);

      const csv = await service.exportInvoices(CLINIC, {} as never);

      expectNoJunk(csv);
    });

    it('prints an amount of zero rather than blanking it', async () => {
      prisma.serviceInvoice.findMany.mockResolvedValue([
        {
          competenceDate: new Date('2026-06-01T00:00:00.000Z'),
          simulatedIssueDate: null,
          issueDate: null,
          status: 'DRAFT',
          customerName: 'Maria',
          customerDocument: null,
          serviceDescription: 'Cortesia',
          amountCents: 0,
          issAmountCents: 0,
          invoiceNumber: null,
          isLegalDocument: false,
          environment: 'LOCAL',
        },
      ]);

      const csv = await service.exportInvoices(CLINIC, {} as never);

      expect(dataFields(csv)).toContain('0,00');
    });
  });
});
