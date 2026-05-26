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
) {
  return {
    id,
    serviceId,
    service: { id: serviceId, name: serviceName },
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
  it('all cost and margin fields are null (v1 limitation)', async () => {
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
});
