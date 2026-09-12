import {
  AppointmentPaymentStatus,
  AppointmentStatus,
  FinancialTransactionStatus,
  FinancialTransactionType,
} from '@prisma/client';

import { MetricsService } from './metrics.service';

/**
 * The productivity dashboard an OWNER sees on login.
 *
 * It is pure derivation over seven queries, which makes it exactly the kind of
 * code that silently drifts: nothing throws when a counter is wrong, the
 * number on the screen is simply false. The classification rules — what counts
 * as low stock, what makes a product critical, which patients count as
 * lapsed, when an action is HIGH priority — are pinned individually.
 *
 * Time is frozen so the 7-, 30- and 60-day windows are deterministic.
 */

const CLINIC = 'clinic-1';
const NOW = new Date('2026-06-15T12:00:00.000Z');

/** Brazil is UTC-3, so 12:00 UTC on 15 June is the same calendar day there. */
const TODAY_UTC_MIDNIGHT = new Date(Date.UTC(2026, 5, 15));

function createPrisma() {
  return {
    appointment: {
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    stockProduct: { findMany: jest.fn().mockResolvedValue([]) },
    financialTransaction: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

const PROFILE = { id: 'p1', displayName: 'Dra. Ana' };

function appointment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    patientName: 'Maria',
    patientPhone: null,
    appointmentDate: TODAY_UTC_MIDNIGHT,
    startTime: new Date('2026-06-15T13:00:00.000Z'),
    status: AppointmentStatus.PENDING,
    paymentStatus: AppointmentPaymentStatus.PAYMENT_PENDING,
    estimatedAmountCents: 10000,
    paidAmountCents: 0,
    cancellationReason: null,
    profile: PROFILE,
    service: { id: 's1', name: 'Limpeza' },
    ...overrides,
  };
}

function product(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prod-1',
    name: 'Luva',
    currentQuantity: 100,
    minQuantity: 10,
    expiresAt: null,
    unit: 'CX',
    category: { name: 'Descartáveis' },
    ...overrides,
  };
}

describe('MetricsService.getProductivitySummary', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let service: MetricsService;

  /** Wires the seven parallel queries, in declaration order. */
  function seed(options: {
    today?: unknown[];
    pendingPayment?: unknown[];
    recentCanceled?: unknown[];
    products?: unknown[];
    transactions?: unknown[];
    lastVisits?: unknown[];
    future?: unknown[];
  }) {
    const findMany = prisma.appointment.findMany as jest.Mock;
    findMany
      .mockResolvedValueOnce(options.today ?? [])
      .mockResolvedValueOnce(options.pendingPayment ?? [])
      .mockResolvedValueOnce(options.recentCanceled ?? [])
      .mockResolvedValueOnce(options.future ?? []);
    prisma.stockProduct.findMany.mockResolvedValue(options.products ?? []);
    prisma.financialTransaction.findMany.mockResolvedValue(
      options.transactions ?? [],
    );
    prisma.appointment.groupBy.mockResolvedValue(options.lastVisits ?? []);
  }

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    prisma = createPrisma();
    service = new MetricsService(prisma as never);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── Today's counters ───────────────────────────────────────────────────────

  describe('today', () => {
    it('reports zeroes for a clinic with nothing scheduled', async () => {
      seed({});
      const summary = await service.getProductivitySummary(CLINIC);

      expect(summary.today).toMatchObject({
        appointmentsTotal: 0,
        appointmentsConfirmed: 0,
        appointmentsPending: 0,
        appointmentsCompleted: 0,
        appointmentsCanceledOrNoShow: 0,
        pendingPaymentsCount: 0,
        pendingPaymentsAmountCents: 0,
      });
    });

    it('counts each status separately', async () => {
      seed({
        today: [
          appointment({ id: '1', status: AppointmentStatus.PENDING }),
          appointment({ id: '2', status: AppointmentStatus.CONFIRMED }),
          appointment({ id: '3', status: AppointmentStatus.COMPLETED }),
          appointment({ id: '4', status: AppointmentStatus.CANCELED }),
          appointment({ id: '5', status: AppointmentStatus.NO_SHOW }),
        ],
      });

      const summary = await service.getProductivitySummary(CLINIC);

      expect(summary.today).toMatchObject({
        appointmentsTotal: 5,
        appointmentsPending: 1,
        appointmentsConfirmed: 1,
        appointmentsCompleted: 1,
        appointmentsCanceled: 1,
        appointmentsNoShow: 1,
        appointmentsCanceledOrNoShow: 2,
      });
    });

    it('uses the Brazil calendar day for the "today" window', async () => {
      seed({});
      const summary = await service.getProductivitySummary(CLINIC);

      expect(summary.today.date).toBe('2026-06-15');
      const where = (prisma.appointment.findMany as jest.Mock).mock.calls[0][0]
        .where;
      expect(where.appointmentDate.gte.toISOString()).toBe(
        '2026-06-15T00:00:00.000Z',
      );
      expect(where.appointmentDate.lt.toISOString()).toBe(
        '2026-06-16T00:00:00.000Z',
      );
    });

    it('does not shift the day during the 00:00–03:00 UTC window', async () => {
      // 01:00 UTC on 16 June is still 15 June in Brazil.
      jest.setSystemTime(new Date('2026-06-16T01:00:00.000Z'));
      seed({});

      const summary = await service.getProductivitySummary(CLINIC);
      expect(summary.today.date).toBe('2026-06-15');
    });

    it('lists only pending and confirmed appointments as still upcoming', async () => {
      seed({
        today: [
          appointment({ id: '1', status: AppointmentStatus.PENDING }),
          appointment({ id: '2', status: AppointmentStatus.CONFIRMED }),
          appointment({ id: '3', status: AppointmentStatus.COMPLETED }),
          appointment({ id: '4', status: AppointmentStatus.CANCELED }),
        ],
      });

      const summary = await service.getProductivitySummary(CLINIC);
      expect(summary.upcomingToday.map((a) => a.id)).toEqual(['1', '2']);
    });

    it('caps the upcoming list at eight', async () => {
      seed({
        today: Array.from({ length: 12 }, (_, i) =>
          appointment({ id: `a${i}`, status: AppointmentStatus.CONFIRMED }),
        ),
      });

      const summary = await service.getProductivitySummary(CLINIC);
      expect(summary.upcomingToday).toHaveLength(8);
    });

    it('reports a null service name rather than omitting the appointment', async () => {
      seed({
        today: [
          appointment({ service: null, status: AppointmentStatus.CONFIRMED }),
        ],
      });

      const summary = await service.getProductivitySummary(CLINIC);
      expect(summary.upcomingToday[0].serviceName).toBeNull();
    });
  });

  // ── Pending payments ───────────────────────────────────────────────────────

  describe('pending payments', () => {
    it('sums the estimated amounts owed', async () => {
      seed({
        pendingPayment: [
          appointment({ id: 'p1', estimatedAmountCents: 15000 }),
          appointment({ id: 'p2', estimatedAmountCents: 25000 }),
        ],
      });

      const summary = await service.getProductivitySummary(CLINIC);

      expect(summary.today.pendingPaymentsCount).toBe(2);
      expect(summary.today.pendingPaymentsAmountCents).toBe(40000);
    });

    it('treats a missing estimate as zero rather than NaN', async () => {
      seed({ pendingPayment: [appointment({ estimatedAmountCents: null })] });

      const summary = await service.getProductivitySummary(CLINIC);
      expect(summary.today.pendingPaymentsAmountCents).toBe(0);
    });

    it('asks only for completed appointments that are unpaid or part-paid', async () => {
      seed({});
      await service.getProductivitySummary(CLINIC);

      const where = (prisma.appointment.findMany as jest.Mock).mock.calls[1][0]
        .where;
      expect(where.status).toBe(AppointmentStatus.COMPLETED);
      expect(where.paymentStatus.in).toEqual([
        AppointmentPaymentStatus.PAYMENT_PENDING,
        AppointmentPaymentStatus.PARTIALLY_PAID,
      ]);
      expect(where.clinicId).toBe(CLINIC);
    });
  });

  // ── Inventory classification ───────────────────────────────────────────────

  describe('inventory', () => {
    it('classifies a depleted product as EMPTY', async () => {
      seed({ products: [product({ currentQuantity: 0 })] });

      const summary = await service.getProductivitySummary(CLINIC);
      expect(summary.inventory.criticalProducts[0].status).toBe('EMPTY');
      expect(summary.inventory.lowStockCount).toBe(1);
    });

    it('classifies a product at its minimum as LOW, not EMPTY', async () => {
      seed({ products: [product({ currentQuantity: 10, minQuantity: 10 })] });

      const summary = await service.getProductivitySummary(CLINIC);
      expect(summary.inventory.criticalProducts[0].status).toBe('LOW');
    });

    it('does not flag a product above its minimum', async () => {
      seed({ products: [product({ currentQuantity: 11, minQuantity: 10 })] });

      const summary = await service.getProductivitySummary(CLINIC);
      expect(summary.inventory.lowStockCount).toBe(0);
      expect(summary.inventory.criticalProducts).toEqual([]);
    });

    it('classifies a past expiry date as EXPIRED', async () => {
      seed({
        products: [
          product({ expiresAt: new Date('2026-06-01T00:00:00.000Z') }),
        ],
      });

      const summary = await service.getProductivitySummary(CLINIC);
      expect(summary.inventory.criticalProducts[0].status).toBe('EXPIRED');
      expect(summary.inventory.expiringSoonCount).toBe(1);
    });

    it('classifies an expiry inside thirty days as EXPIRING', async () => {
      seed({
        products: [
          product({ expiresAt: new Date('2026-07-01T00:00:00.000Z') }),
        ],
      });

      const summary = await service.getProductivitySummary(CLINIC);
      expect(summary.inventory.criticalProducts[0].status).toBe('EXPIRING');
    });

    it('ignores an expiry beyond thirty days', async () => {
      seed({
        products: [
          product({ expiresAt: new Date('2026-12-01T00:00:00.000Z') }),
        ],
      });

      const summary = await service.getProductivitySummary(CLINIC);
      expect(summary.inventory.expiringSoonCount).toBe(0);
      expect(summary.inventory.criticalProducts).toEqual([]);
    });

    it('reports a product that is both empty and expired under the stock status', async () => {
      // Being out of stock is the more actionable of the two.
      seed({
        products: [
          product({
            currentQuantity: 0,
            expiresAt: new Date('2026-01-01T00:00:00.000Z'),
          }),
        ],
      });

      const summary = await service.getProductivitySummary(CLINIC);
      expect(summary.inventory.criticalProducts[0].status).toBe('EMPTY');
      expect(summary.inventory.lowStockCount).toBe(1);
      expect(summary.inventory.expiringSoonCount).toBe(1);
    });

    it('caps the critical list at five while still counting them all', async () => {
      seed({
        products: Array.from({ length: 9 }, (_, i) =>
          product({ id: `p${i}`, currentQuantity: 0 }),
        ),
      });

      const summary = await service.getProductivitySummary(CLINIC);
      expect(summary.inventory.criticalProducts).toHaveLength(5);
      expect(summary.inventory.lowStockCount).toBe(9);
    });

    it('formats the expiry as a Brazil calendar date', async () => {
      seed({
        products: [
          product({ expiresAt: new Date('2026-07-01T00:00:00.000Z') }),
        ],
      });

      const summary = await service.getProductivitySummary(CLINIC);
      expect(summary.inventory.criticalProducts[0].expiresAt).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      );
    });

    it('reports a null category rather than failing on an uncategorised product', async () => {
      seed({ products: [product({ currentQuantity: 0, category: null })] });

      const summary = await service.getProductivitySummary(CLINIC);
      expect(summary.inventory.criticalProducts[0].categoryName).toBeNull();
    });

    it('considers only active products', async () => {
      seed({});
      await service.getProductivitySummary(CLINIC);

      expect(prisma.stockProduct.findMany.mock.calls[0][0].where).toMatchObject(
        {
          clinicId: CLINIC,
          isActive: true,
        },
      );
    });
  });

  // ── Finance ────────────────────────────────────────────────────────────────

  describe('finance', () => {
    function tx(
      type: FinancialTransactionType,
      status: FinancialTransactionStatus,
      amount: number,
    ) {
      return { type, status, amount };
    }

    it('separates paid income, paid expenses and pending receivables', async () => {
      seed({
        transactions: [
          tx(
            FinancialTransactionType.INCOME,
            FinancialTransactionStatus.PAID,
            1000,
          ),
          tx(
            FinancialTransactionType.INCOME,
            FinancialTransactionStatus.PENDING,
            400,
          ),
          tx(
            FinancialTransactionType.EXPENSE,
            FinancialTransactionStatus.PAID,
            300,
          ),
        ],
      });

      const summary = await service.getProductivitySummary(CLINIC);

      expect(summary.finance).toEqual({
        monthIncome: 1000,
        monthExpenses: 300,
        monthNet: 700,
        pendingReceivables: 400,
      });
    });

    it('excludes an unpaid expense from the month total', async () => {
      seed({
        transactions: [
          tx(
            FinancialTransactionType.EXPENSE,
            FinancialTransactionStatus.PENDING,
            999,
          ),
        ],
      });

      const summary = await service.getProductivitySummary(CLINIC);
      expect(summary.finance.monthExpenses).toBe(0);
    });

    it('reports a negative net when expenses exceed income', async () => {
      seed({
        transactions: [
          tx(
            FinancialTransactionType.INCOME,
            FinancialTransactionStatus.PAID,
            100,
          ),
          tx(
            FinancialTransactionType.EXPENSE,
            FinancialTransactionStatus.PAID,
            500,
          ),
        ],
      });

      const summary = await service.getProductivitySummary(CLINIC);
      expect(summary.finance.monthNet).toBe(-400);
    });

    it('scopes the month window to the Brazil calendar month', async () => {
      seed({});
      await service.getProductivitySummary(CLINIC);

      const where = prisma.financialTransaction.findMany.mock.calls[0][0].where;
      expect(where.clinicId).toBe(CLINIC);
      expect(where.transactionDate.gte.toISOString()).toBe(
        '2026-06-01T00:00:00.000Z',
      );
      expect(where.transactionDate.lt.toISOString()).toBe(
        '2026-07-01T00:00:00.000Z',
      );
    });
  });

  // ── Lapsed patients ────────────────────────────────────────────────────────

  describe('patients without return', () => {
    function lastVisit(
      name: string,
      date: Date | null,
      phone: string | null = null,
    ) {
      return {
        patientName: name,
        patientPhone: phone,
        _max: { appointmentDate: date },
      };
    }

    it('counts a patient last seen more than sixty days ago', async () => {
      seed({
        lastVisits: [lastVisit('Maria', new Date('2026-01-01T00:00:00.000Z'))],
      });

      const summary = await service.getProductivitySummary(CLINIC);
      expect(summary.patients.withoutReturnCount).toBe(1);
      expect(summary.patients.examples[0].patientName).toBe('Maria');
    });

    it('ignores a patient seen within sixty days', async () => {
      seed({
        lastVisits: [lastVisit('Maria', new Date('2026-06-01T00:00:00.000Z'))],
      });

      const summary = await service.getProductivitySummary(CLINIC);
      expect(summary.patients.withoutReturnCount).toBe(0);
    });

    it('ignores a lapsed patient who already has a future appointment', async () => {
      seed({
        lastVisits: [
          lastVisit('Maria', new Date('2026-01-01T00:00:00.000Z'), '119999'),
        ],
        future: [{ patientName: 'Maria', patientPhone: '119999' }],
      });

      const summary = await service.getProductivitySummary(CLINIC);
      expect(summary.patients.withoutReturnCount).toBe(0);
    });

    it('distinguishes same-named patients by phone number', async () => {
      seed({
        lastVisits: [
          lastVisit('Maria', new Date('2026-01-01T00:00:00.000Z'), '111'),
          lastVisit('Maria', new Date('2026-01-01T00:00:00.000Z'), '222'),
        ],
        future: [{ patientName: 'Maria', patientPhone: '111' }],
      });

      const summary = await service.getProductivitySummary(CLINIC);
      expect(summary.patients.withoutReturnCount).toBe(1);
      expect(summary.patients.examples[0].patientPhone).toBe('222');
    });

    it('matches a patient with no phone on record', async () => {
      seed({
        lastVisits: [
          lastVisit('Maria', new Date('2026-01-01T00:00:00.000Z'), null),
        ],
        future: [{ patientName: 'Maria', patientPhone: null }],
      });

      const summary = await service.getProductivitySummary(CLINIC);
      expect(summary.patients.withoutReturnCount).toBe(0);
    });

    it('ignores a patient with no recorded visit date', async () => {
      seed({ lastVisits: [lastVisit('Maria', null)] });

      const summary = await service.getProductivitySummary(CLINIC);
      expect(summary.patients.withoutReturnCount).toBe(0);
    });

    it('caps the examples at five while still counting them all', async () => {
      seed({
        lastVisits: Array.from({ length: 8 }, (_, i) =>
          lastVisit(
            `Paciente ${i}`,
            new Date('2026-01-01T00:00:00.000Z'),
            `${i}`,
          ),
        ),
      });

      const summary = await service.getProductivitySummary(CLINIC);
      expect(summary.patients.withoutReturnCount).toBe(8);
      expect(summary.patients.examples).toHaveLength(5);
    });
  });

  // ── Recommended actions ────────────────────────────────────────────────────

  describe('recommended actions', () => {
    it('suggests nothing when there is nothing to do', async () => {
      seed({});
      const summary = await service.getProductivitySummary(CLINIC);
      expect(summary.actions).toEqual([]);
    });

    it('raises confirming today’s schedule as HIGH priority', async () => {
      seed({ today: [appointment({ status: AppointmentStatus.PENDING })] });

      const summary = await service.getProductivitySummary(CLINIC);
      const action = summary.actions.find((a) => a.type === 'TODAY_SCHEDULE');
      expect(action?.priority).toBe('HIGH');
      expect(action?.description).toContain('1 consulta aguarda');
    });

    it('pluralises the schedule prompt', async () => {
      seed({
        today: [
          appointment({ id: '1', status: AppointmentStatus.PENDING }),
          appointment({ id: '2', status: AppointmentStatus.PENDING }),
        ],
      });

      const summary = await service.getProductivitySummary(CLINIC);
      expect(summary.actions[0].description).toContain('2 consultas aguardam');
    });

    it('treats one or two unpaid appointments as MEDIUM priority', async () => {
      seed({
        pendingPayment: [appointment({ id: 'p1' }), appointment({ id: 'p2' })],
      });

      const summary = await service.getProductivitySummary(CLINIC);
      expect(
        summary.actions.find((a) => a.type === 'PENDING_PAYMENT')?.priority,
      ).toBe('MEDIUM');
    });

    it('escalates to HIGH at three unpaid appointments', async () => {
      seed({
        pendingPayment: [
          appointment({ id: 'p1' }),
          appointment({ id: 'p2' }),
          appointment({ id: 'p3' }),
        ],
      });

      const summary = await service.getProductivitySummary(CLINIC);
      expect(
        summary.actions.find((a) => a.type === 'PENDING_PAYMENT')?.priority,
      ).toBe('HIGH');
    });

    it('reports a stock alert as LOW_STOCK when anything is low', async () => {
      seed({ products: [product({ currentQuantity: 0 })] });

      const summary = await service.getProductivitySummary(CLINIC);
      expect(summary.actions.find((a) => a.href === '/app/estoque')?.type).toBe(
        'LOW_STOCK',
      );
    });

    it('reports EXPIRING_STOCK when only expiry is the problem', async () => {
      seed({
        products: [
          product({ expiresAt: new Date('2026-07-01T00:00:00.000Z') }),
        ],
      });

      const summary = await service.getProductivitySummary(CLINIC);
      expect(summary.actions.find((a) => a.href === '/app/estoque')?.type).toBe(
        'EXPIRING_STOCK',
      );
    });

    it('suggests patient follow-up at LOW priority', async () => {
      seed({
        lastVisits: [
          {
            patientName: 'Maria',
            patientPhone: null,
            _max: { appointmentDate: new Date('2026-01-01') },
          },
        ],
      });

      const summary = await service.getProductivitySummary(CLINIC);
      const action = summary.actions.find(
        (a) => a.type === 'PATIENT_FOLLOW_UP',
      );
      expect(action?.priority).toBe('LOW');
      expect(action?.description).toContain('1 paciente');
    });

    it('orders actions from most to least urgent concern', async () => {
      seed({
        today: [appointment({ status: AppointmentStatus.PENDING })],
        pendingPayment: [appointment({ id: 'p1' })],
        products: [product({ currentQuantity: 0 })],
        lastVisits: [
          {
            patientName: 'Maria',
            patientPhone: null,
            _max: { appointmentDate: new Date('2026-01-01') },
          },
        ],
      });

      const summary = await service.getProductivitySummary(CLINIC);
      expect(summary.actions.map((a) => a.type)).toEqual([
        'TODAY_SCHEDULE',
        'PENDING_PAYMENT',
        'LOW_STOCK',
        'PATIENT_FOLLOW_UP',
      ]);
    });
  });

  // ── Tenant scoping ─────────────────────────────────────────────────────────

  it('scopes every query to the caller’s clinic', async () => {
    seed({});
    await service.getProductivitySummary(CLINIC);

    const wheres = [
      ...(prisma.appointment.findMany as jest.Mock).mock.calls,
      ...prisma.stockProduct.findMany.mock.calls,
      ...prisma.financialTransaction.findMany.mock.calls,
      ...prisma.appointment.groupBy.mock.calls,
    ].map(([args]) => args.where);

    expect(wheres.every((where) => where.clinicId === CLINIC)).toBe(true);
  });
});
