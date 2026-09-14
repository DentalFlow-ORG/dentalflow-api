import { ReportsService } from '../../src/modules/reports/reports.service';
import {
  createIntegrationHarness,
  IntegrationHarness,
} from '../support/integration-harness';
import {
  createAppointment,
  createFinancialCategory,
  createStockCategory,
  createTransaction,
  seedTwoClinics,
  utcDate,
} from '../support/factories';

/**
 * CSV export dates, read back from real PostgreSQL.
 *
 * The unit suite proves the formatter renders a UTC-midnight `Date` as the
 * same calendar day. This proves the premise underneath it: that a `@db.Date`
 * column really does come back from the driver as UTC midnight, so the
 * formatter is being handed what the unit test assumes.
 *
 * That premise is exactly what a mock cannot establish, and it is the one the
 * off-by-one-day defect turned on.
 */
describe('Report export dates (real database)', () => {
  let h: IntegrationHarness;
  let service: ReportsService;

  beforeAll(async () => {
    h = await createIntegrationHarness();
    service = h.app.get(ReportsService);
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await h.truncate();
    await seedTwoClinics(h.prisma);
  });

  it('exports a transaction on the calendar day it was recorded', async () => {
    await createFinancialCategory(h.prisma, {
      id: 'cat-export',
      clinicId: 'clinic-a',
    });
    await createTransaction(h.prisma, {
      id: 'tx-export',
      clinicId: 'clinic-a',
      categoryId: 'cat-export',
      createdByUserId: 'owner-a',
      transactionDate: utcDate('2026-06-10'),
    });

    const csv = await service.exportFinance('clinic-a', {} as never);

    expect(csv).toContain('10/06/2026');
    expect(csv).not.toContain('09/06/2026');
  });

  it('exports an appointment on the calendar day it is scheduled', async () => {
    await createAppointment(h.prisma, {
      id: 'appt-export',
      clinicId: 'clinic-a',
      profileId: 'profile-a',
      appointmentDate: utcDate('2026-06-10'),
    });

    const csv = await service.exportAppointments('clinic-a', {} as never);

    expect(csv).toContain('10/06/2026');
    expect(csv).not.toContain('09/06/2026');
  });

  it('exports a product expiry on the stored date', async () => {
    await createStockCategory(h.prisma, {
      id: 'cat-stock-export',
      clinicId: 'clinic-a',
    });
    await h.prisma.stockProduct.create({
      data: {
        id: 'prod-export',
        clinicId: 'clinic-a',
        categoryId: 'cat-stock-export',
        name: 'Anestésico',
        unit: 'CX',
        currentQuantity: 10,
        minQuantity: 2,
        expiresAt: utcDate('2027-03-01'),
      },
    });

    const csv = await service.exportInventory('clinic-a', {} as never);

    expect(csv).toContain('01/03/2027');
    expect(csv).not.toContain('28/02/2027');
  });

  it('reads a DATE column back as UTC midnight, which the formatter relies on', async () => {
    await createFinancialCategory(h.prisma, {
      id: 'cat-premise',
      clinicId: 'clinic-a',
    });
    await createTransaction(h.prisma, {
      id: 'tx-premise',
      clinicId: 'clinic-a',
      categoryId: 'cat-premise',
      createdByUserId: 'owner-a',
      transactionDate: utcDate('2026-06-10'),
    });

    const row = await h.prisma.financialTransaction.findUniqueOrThrow({
      where: { id: 'tx-premise' },
    });

    expect(row.transactionDate.toISOString()).toBe('2026-06-10T00:00:00.000Z');
  });
});
