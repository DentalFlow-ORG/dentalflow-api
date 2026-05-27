import 'reflect-metadata';
import { AppointmentStatus } from '@prisma/client';
import { ProcedureMarginsService } from './procedure-margins.service';

const CLINIC_ID = 'clinic_1';
const SVC_A = 'svc_a';
const SVC_B = 'svc_b';
const SVC_C = 'svc_c';

function makeAppt(
  id: string,
  serviceId: string,
  serviceName: string,
  status: AppointmentStatus,
  paidAmountCents: number | null = null,
  estimatedAmountCents: number | null = null,
  serviceDirectCostCents: number | null = null,
) {
  return {
    id,
    serviceId,
    service: { id: serviceId, name: serviceName, estimatedDirectCostCents: serviceDirectCostCents },
    status,
    paidAmountCents,
    estimatedAmountCents,
  };
}

function makeTx(appointmentId: string, amount: string) {
  return { appointmentId, amount };
}

function buildSvc() {
  const prisma = {
    appointment: { findMany: jest.fn() },
    financialTransaction: { findMany: jest.fn() },
  };
  const svc = new ProcedureMarginsService(prisma as any);
  return { svc, prisma };
}

// ── 1. Period resolution: month param ────────────────────────────────────────

describe('resolvePeriod', () => {
  const { svc } = buildSvc();

  it('resolves month param to first/last day of that month', () => {
    const period = svc.resolvePeriod({ month: '2026-05' });
    expect(period.from.toISOString().slice(0, 10)).toBe('2026-05-01');
    expect(period.to.toISOString().slice(0, 10)).toBe('2026-05-31');
  });

  it('resolves startDate/endDate params', () => {
    const period = svc.resolvePeriod({
      startDate: '2026-04-01',
      endDate: '2026-04-15',
    });
    expect(period.from.toISOString().slice(0, 10)).toBe('2026-04-01');
    expect(period.to.toISOString().slice(0, 10)).toBe('2026-04-15');
  });

  it('defaults to current month when no params provided', () => {
    const period = svc.resolvePeriod({});
    const now = new Date();
    const expectedMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    expect(period.from.toISOString().slice(0, 7)).toBe(expectedMonth);
    expect(period.from.getUTCDate()).toBe(1);
  });
});

// ── 2. Status determination ───────────────────────────────────────────────────

describe('determineStatus', () => {
  const { svc } = buildSvc();

  it('returns HEALTHY when completion is high and cancellation rate < 40%', () => {
    expect(svc.determineStatus(5, 4, 1)).toBe('HEALTHY');
  });

  it('returns ATTENTION when 0 completed appointments (total >= 3)', () => {
    expect(svc.determineStatus(3, 0, 0)).toBe('ATTENTION');
  });

  it('returns ATTENTION when cancellation/no-show rate >= 40%', () => {
    expect(svc.determineStatus(5, 3, 2)).toBe('ATTENTION');
  });

  it('returns INSUFFICIENT_DATA when total < 3', () => {
    expect(svc.determineStatus(2, 2, 0)).toBe('INSUFFICIENT_DATA');
  });
});

// ── 3. Revenue computation ────────────────────────────────────────────────────

describe('computeAppointmentRevenue', () => {
  const { svc } = buildSvc();

  it('uses transaction amount when transaction exists for appointment', () => {
    const appt = { id: 'a1', status: AppointmentStatus.COMPLETED, paidAmountCents: 5000, estimatedAmountCents: 6000 };
    const txMap = new Map([['a1', 8000]]);
    expect(svc.computeAppointmentRevenue(appt, txMap)).toBe(8000);
  });

  it('falls back to paidAmountCents when no transaction', () => {
    const appt = { id: 'a2', status: AppointmentStatus.COMPLETED, paidAmountCents: 5000, estimatedAmountCents: 6000 };
    const txMap = new Map<string, number>();
    expect(svc.computeAppointmentRevenue(appt, txMap)).toBe(5000);
  });

  it('falls back to estimatedAmountCents for COMPLETED when no tx and no paidAmountCents', () => {
    const appt = { id: 'a3', status: AppointmentStatus.COMPLETED, paidAmountCents: null, estimatedAmountCents: 7000 };
    const txMap = new Map<string, number>();
    expect(svc.computeAppointmentRevenue(appt, txMap)).toBe(7000);
  });

  it('returns 0 for CANCELED appointment regardless of tx/amounts', () => {
    const appt = { id: 'a4', status: AppointmentStatus.CANCELED, paidAmountCents: 5000, estimatedAmountCents: 6000 };
    const txMap = new Map([['a4', 8000]]);
    expect(svc.computeAppointmentRevenue(appt, txMap)).toBe(0);
  });
});

// ── 4. getMargins integration ─────────────────────────────────────────────────

describe('getMargins', () => {
  it('all cost and margin fields are null when no cost is configured', async () => {
    const { svc, prisma } = buildSvc();
    prisma.appointment.findMany.mockResolvedValue([
      makeAppt('a1', SVC_A, 'Limpeza', AppointmentStatus.COMPLETED, 10000),
      makeAppt('a2', SVC_A, 'Limpeza', AppointmentStatus.COMPLETED, 10000),
      makeAppt('a3', SVC_A, 'Limpeza', AppointmentStatus.COMPLETED, 10000),
    ]);
    prisma.financialTransaction.findMany.mockResolvedValue([]);

    const result = await svc.getMargins(CLINIC_ID, { month: '2026-05' });

    expect(result.totals.estimatedDirectCostCents).toBeNull();
    expect(result.totals.estimatedProfitCents).toBeNull();
    expect(result.totals.marginPercent).toBeNull();
    expect(result.costDataAvailable).toBe(false);
    for (const item of result.items) {
      expect(item.estimatedDirectCostCents).toBeNull();
      expect(item.estimatedProfitCents).toBeNull();
      expect(item.marginPercent).toBeNull();
    }
  });

  it('sorts ATTENTION before HEALTHY', async () => {
    const { svc, prisma } = buildSvc();
    // SVC_A: 3 completed → HEALTHY
    // SVC_B: 3 total, 0 completed → ATTENTION
    prisma.appointment.findMany.mockResolvedValue([
      makeAppt('a1', SVC_A, 'Limpeza', AppointmentStatus.COMPLETED, 10000),
      makeAppt('a2', SVC_A, 'Limpeza', AppointmentStatus.COMPLETED, 10000),
      makeAppt('a3', SVC_A, 'Limpeza', AppointmentStatus.COMPLETED, 10000),
      makeAppt('b1', SVC_B, 'Extração', AppointmentStatus.PENDING),
      makeAppt('b2', SVC_B, 'Extração', AppointmentStatus.CONFIRMED),
      makeAppt('b3', SVC_B, 'Extração', AppointmentStatus.PENDING),
    ]);
    prisma.financialTransaction.findMany.mockResolvedValue([]);

    const result = await svc.getMargins(CLINIC_ID, { month: '2026-05' });

    expect(result.items[0].serviceId).toBe(SVC_B);
    expect(result.items[0].status).toBe('ATTENTION');
    expect(result.items[1].serviceId).toBe(SVC_A);
    expect(result.items[1].status).toBe('HEALTHY');
  });

  it('sorts INSUFFICIENT_DATA after HEALTHY', async () => {
    const { svc, prisma } = buildSvc();
    // SVC_A: 3 completed → HEALTHY
    // SVC_C: 2 appointments → INSUFFICIENT_DATA
    prisma.appointment.findMany.mockResolvedValue([
      makeAppt('a1', SVC_A, 'Limpeza', AppointmentStatus.COMPLETED, 10000),
      makeAppt('a2', SVC_A, 'Limpeza', AppointmentStatus.COMPLETED, 10000),
      makeAppt('a3', SVC_A, 'Limpeza', AppointmentStatus.COMPLETED, 10000),
      makeAppt('c1', SVC_C, 'Clareamento', AppointmentStatus.COMPLETED, 20000),
      makeAppt('c2', SVC_C, 'Clareamento', AppointmentStatus.COMPLETED, 20000),
    ]);
    prisma.financialTransaction.findMany.mockResolvedValue([]);

    const result = await svc.getMargins(CLINIC_ID, { month: '2026-05' });

    const statuses = result.items.map((i) => i.status);
    expect(statuses.indexOf('HEALTHY')).toBeLessThan(statuses.indexOf('INSUFFICIENT_DATA'));
  });

  it('calculates avgRevenueCents as round(grossRevenue / completedAppointments)', async () => {
    const { svc, prisma } = buildSvc();
    // 3 completed, 2 with tx amounts
    prisma.appointment.findMany.mockResolvedValue([
      makeAppt('a1', SVC_A, 'Limpeza', AppointmentStatus.COMPLETED),
      makeAppt('a2', SVC_A, 'Limpeza', AppointmentStatus.COMPLETED),
      makeAppt('a3', SVC_A, 'Limpeza', AppointmentStatus.COMPLETED),
    ]);
    prisma.financialTransaction.findMany.mockResolvedValue([
      makeTx('a1', '100.00'),  // 10000 cents
      makeTx('a2', '80.00'),   // 8000 cents
      makeTx('a3', '120.00'),  // 12000 cents
    ]);

    const result = await svc.getMargins(CLINIC_ID, { month: '2026-05' });
    const item = result.items[0];

    expect(item.grossRevenueCents).toBe(30000);
    expect(item.avgRevenueCents).toBe(10000);
  });

  it('sets avgRevenueCents to 0 when completedAppointments is 0', async () => {
    const { svc, prisma } = buildSvc();
    prisma.appointment.findMany.mockResolvedValue([
      makeAppt('b1', SVC_B, 'Extração', AppointmentStatus.PENDING),
      makeAppt('b2', SVC_B, 'Extração', AppointmentStatus.CONFIRMED),
      makeAppt('b3', SVC_B, 'Extração', AppointmentStatus.PENDING),
    ]);
    prisma.financialTransaction.findMany.mockResolvedValue([]);

    const result = await svc.getMargins(CLINIC_ID, { month: '2026-05' });

    expect(result.items[0].completedAppointments).toBe(0);
    expect(result.items[0].avgRevenueCents).toBe(0);
  });

  it('passes profileId filter to appointment query', async () => {
    const { svc, prisma } = buildSvc();
    prisma.appointment.findMany.mockResolvedValue([]);
    prisma.financialTransaction.findMany.mockResolvedValue([]);

    await svc.getMargins(CLINIC_ID, { month: '2026-05', profileId: 'prof_1' });

    expect(prisma.appointment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ profileId: 'prof_1' }),
      }),
    );
  });

  it('enforces tenant isolation: clinicId always in appointment where clause', async () => {
    const { svc, prisma } = buildSvc();
    prisma.appointment.findMany.mockResolvedValue([]);
    prisma.financialTransaction.findMany.mockResolvedValue([]);

    await svc.getMargins(CLINIC_ID, { month: '2026-05' });

    expect(prisma.appointment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ clinicId: CLINIC_ID }),
      }),
    );
  });

  it('computes cost, profit and margin when service has estimatedDirectCostCents', async () => {
    const { svc, prisma } = buildSvc();
    // 3 completed, each paid 15000 cents, direct cost = 5000 per appointment
    prisma.appointment.findMany.mockResolvedValue([
      makeAppt('a1', SVC_A, 'Limpeza', AppointmentStatus.COMPLETED, 15000, null, 5000),
      makeAppt('a2', SVC_A, 'Limpeza', AppointmentStatus.COMPLETED, 15000, null, 5000),
      makeAppt('a3', SVC_A, 'Limpeza', AppointmentStatus.COMPLETED, 15000, null, 5000),
    ]);
    prisma.financialTransaction.findMany.mockResolvedValue([]);

    const result = await svc.getMargins(CLINIC_ID, { month: '2026-05' });
    const item = result.items[0];

    // cost = 5000 * 3 = 15000, profit = 45000 - 15000 = 30000, margin = 66.67%
    expect(item.grossRevenueCents).toBe(45000);
    expect(item.estimatedDirectCostCents).toBe(15000);
    expect(item.estimatedProfitCents).toBe(30000);
    expect(item.marginPercent).toBe(66.67);
    expect(result.costDataAvailable).toBe(true);
    expect(result.limitation).toBeNull();
  });

  it('scales cost by completedAppointments (not total appointments)', async () => {
    const { svc, prisma } = buildSvc();
    // 5 total: 3 completed + 1 canceled + 1 no-show; direct cost = 2000
    prisma.appointment.findMany.mockResolvedValue([
      makeAppt('a1', SVC_A, 'Limpeza', AppointmentStatus.COMPLETED, 10000, null, 2000),
      makeAppt('a2', SVC_A, 'Limpeza', AppointmentStatus.COMPLETED, 10000, null, 2000),
      makeAppt('a3', SVC_A, 'Limpeza', AppointmentStatus.COMPLETED, 10000, null, 2000),
      makeAppt('a4', SVC_A, 'Limpeza', AppointmentStatus.CANCELED, null, null, 2000),
      makeAppt('a5', SVC_A, 'Limpeza', AppointmentStatus.NO_SHOW, null, null, 2000),
    ]);
    prisma.financialTransaction.findMany.mockResolvedValue([]);

    const result = await svc.getMargins(CLINIC_ID, { month: '2026-05' });
    const item = result.items[0];

    // cost = 2000 * 3 completed = 6000 (not 5 total)
    expect(item.completedAppointments).toBe(3);
    expect(item.estimatedDirectCostCents).toBe(6000);
    expect(item.grossRevenueCents).toBe(30000);
    expect(item.estimatedProfitCents).toBe(24000);
  });

  it('totals remain null when only some services have cost configured', async () => {
    const { svc, prisma } = buildSvc();
    // SVC_A: cost configured; SVC_B: no cost
    prisma.appointment.findMany.mockResolvedValue([
      makeAppt('a1', SVC_A, 'Limpeza', AppointmentStatus.COMPLETED, 10000, null, 5000),
      makeAppt('a2', SVC_A, 'Limpeza', AppointmentStatus.COMPLETED, 10000, null, 5000),
      makeAppt('a3', SVC_A, 'Limpeza', AppointmentStatus.COMPLETED, 10000, null, 5000),
      makeAppt('b1', SVC_B, 'Extração', AppointmentStatus.COMPLETED, 20000),
      makeAppt('b2', SVC_B, 'Extração', AppointmentStatus.COMPLETED, 20000),
      makeAppt('b3', SVC_B, 'Extração', AppointmentStatus.COMPLETED, 20000),
    ]);
    prisma.financialTransaction.findMany.mockResolvedValue([]);

    const result = await svc.getMargins(CLINIC_ID, { month: '2026-05' });

    expect(result.costDataAvailable).toBe(false);
    expect(result.totals.estimatedDirectCostCents).toBeNull();
    expect(result.totals.estimatedProfitCents).toBeNull();
    expect(result.totals.marginPercent).toBeNull();
    expect(result.limitation).not.toBeNull();
    // per-item cost still computed for the service that has it
    const itemA = result.items.find((i) => i.serviceId === SVC_A)!;
    expect(itemA.estimatedDirectCostCents).toBe(15000);
    const itemB = result.items.find((i) => i.serviceId === SVC_B)!;
    expect(itemB.estimatedDirectCostCents).toBeNull();
  });

  it('computes aggregate totals when all services have cost configured', async () => {
    const { svc, prisma } = buildSvc();
    // SVC_A: 3 completed, cost=5000, paid=10000 each → gross=30000, cost=15000, profit=15000
    // SVC_B: 3 completed, cost=3000, paid=8000 each  → gross=24000, cost=9000, profit=15000
    // totals: gross=54000, cost=24000, profit=30000, margin=55.56%
    prisma.appointment.findMany.mockResolvedValue([
      makeAppt('a1', SVC_A, 'Limpeza', AppointmentStatus.COMPLETED, 10000, null, 5000),
      makeAppt('a2', SVC_A, 'Limpeza', AppointmentStatus.COMPLETED, 10000, null, 5000),
      makeAppt('a3', SVC_A, 'Limpeza', AppointmentStatus.COMPLETED, 10000, null, 5000),
      makeAppt('b1', SVC_B, 'Extração', AppointmentStatus.COMPLETED, 8000, null, 3000),
      makeAppt('b2', SVC_B, 'Extração', AppointmentStatus.COMPLETED, 8000, null, 3000),
      makeAppt('b3', SVC_B, 'Extração', AppointmentStatus.COMPLETED, 8000, null, 3000),
    ]);
    prisma.financialTransaction.findMany.mockResolvedValue([]);

    const result = await svc.getMargins(CLINIC_ID, { month: '2026-05' });

    expect(result.costDataAvailable).toBe(true);
    expect(result.limitation).toBeNull();
    expect(result.totals.grossRevenueCents).toBe(54000);
    expect(result.totals.estimatedDirectCostCents).toBe(24000);
    expect(result.totals.estimatedProfitCents).toBe(30000);
    expect(result.totals.marginPercent).toBe(55.56);
  });

  it('marginPercent is null when grossRevenueCents is 0 (zero-revenue safety)', async () => {
    const { svc, prisma } = buildSvc();
    // 3 PENDING appointments — revenue = 0, but cost is configured
    prisma.appointment.findMany.mockResolvedValue([
      makeAppt('a1', SVC_A, 'Limpeza', AppointmentStatus.PENDING, null, null, 5000),
      makeAppt('a2', SVC_A, 'Limpeza', AppointmentStatus.PENDING, null, null, 5000),
      makeAppt('a3', SVC_A, 'Limpeza', AppointmentStatus.PENDING, null, null, 5000),
    ]);
    prisma.financialTransaction.findMany.mockResolvedValue([]);

    const result = await svc.getMargins(CLINIC_ID, { month: '2026-05' });
    const item = result.items[0];

    expect(item.grossRevenueCents).toBe(0);
    expect(item.estimatedDirectCostCents).toBe(0); // 5000 * 0 completed = 0
    expect(item.estimatedProfitCents).toBe(0);
    expect(item.marginPercent).toBeNull();
    expect(result.totals.marginPercent).toBeNull();
  });
});
