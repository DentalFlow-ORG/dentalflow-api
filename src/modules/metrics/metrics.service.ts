import { Injectable } from '@nestjs/common';
import {
  AppointmentPaymentStatus,
  AppointmentStatus,
  FinancialTransactionStatus,
  FinancialTransactionType,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

type ActionPriority = 'HIGH' | 'MEDIUM' | 'LOW';

@Injectable()
export class MetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async getProductivitySummary(clinicId: string) {
    const now = new Date();
    const todayStr = this.isoDate(now);
    const [y, m, d] = todayStr.split('-').map(Number);

    const todayStart = new Date(Date.UTC(y, m - 1, d));
    const todayEnd = new Date(Date.UTC(y, m - 1, d + 1));
    const monthStart = new Date(Date.UTC(y, m - 1, 1));
    const monthEnd = new Date(Date.UTC(y, m, 1));
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    const thirtyDaysLater = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const [
      todayAppointments,
      pendingPaymentAppts,
      recentCanceled,
      inventoryProducts,
      financeTransactions,
      patientsLastVisit,
      patientsWithFuture,
    ] = await Promise.all([
      this.prisma.appointment.findMany({
        where: { clinicId, appointmentDate: { gte: todayStart, lt: todayEnd } },
        select: {
          id: true,
          patientName: true,
          startTime: true,
          status: true,
          paymentStatus: true,
          estimatedAmountCents: true,
          profile: { select: { id: true, displayName: true } },
          service: { select: { id: true, name: true } },
        },
        orderBy: { startTime: 'asc' },
      }),

      this.prisma.appointment.findMany({
        where: {
          clinicId,
          status: AppointmentStatus.COMPLETED,
          paymentStatus: {
            in: [
              AppointmentPaymentStatus.PAYMENT_PENDING,
              AppointmentPaymentStatus.PARTIALLY_PAID,
            ],
          },
        },
        select: {
          id: true,
          patientName: true,
          patientPhone: true,
          appointmentDate: true,
          startTime: true,
          estimatedAmountCents: true,
          paidAmountCents: true,
          paymentStatus: true,
          profile: { select: { id: true, displayName: true } },
          service: { select: { id: true, name: true } },
        },
        orderBy: { appointmentDate: 'desc' },
        take: 10,
      }),

      this.prisma.appointment.findMany({
        where: {
          clinicId,
          status: AppointmentStatus.CANCELED,
          canceledAt: { gte: sevenDaysAgo },
        },
        select: {
          id: true,
          patientName: true,
          appointmentDate: true,
          startTime: true,
          cancellationReason: true,
          profile: { select: { id: true, displayName: true } },
        },
        orderBy: { canceledAt: 'desc' },
        take: 5,
      }),

      this.prisma.stockProduct.findMany({
        where: { clinicId, isActive: true },
        select: {
          id: true,
          name: true,
          currentQuantity: true,
          minQuantity: true,
          expiresAt: true,
          unit: true,
          category: { select: { name: true } },
        },
      }),

      this.prisma.financialTransaction.findMany({
        where: {
          clinicId,
          transactionDate: { gte: monthStart, lt: monthEnd },
          status: { not: FinancialTransactionStatus.CANCELED },
        },
        select: { type: true, status: true, amount: true },
      }),

      this.prisma.appointment.groupBy({
        by: ['patientName', 'patientPhone'],
        where: { clinicId },
        _max: { appointmentDate: true },
      }),

      this.prisma.appointment.findMany({
        where: {
          clinicId,
          appointmentDate: { gte: todayStart },
          status: {
            in: [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED],
          },
        },
        select: { patientName: true, patientPhone: true },
        distinct: ['patientName', 'patientPhone'],
      }),
    ]);

    // ── Today stats ────────────────────────────────────────────────────────────
    const todayTotal = todayAppointments.length;
    const todayConfirmed = todayAppointments.filter(
      (a) => a.status === AppointmentStatus.CONFIRMED,
    ).length;
    const todayPending = todayAppointments.filter(
      (a) => a.status === AppointmentStatus.PENDING,
    ).length;
    const todayCompleted = todayAppointments.filter(
      (a) => a.status === AppointmentStatus.COMPLETED,
    ).length;
    const todayCanceledOrNoShow = todayAppointments.filter(
      (a) =>
        a.status === AppointmentStatus.CANCELED ||
        a.status === AppointmentStatus.NO_SHOW,
    ).length;

    const pendingPaymentsCount = pendingPaymentAppts.length;
    const pendingPaymentsAmountCents = pendingPaymentAppts.reduce(
      (sum, a) => sum + (a.estimatedAmountCents ?? 0),
      0,
    );

    const upcomingToday = todayAppointments
      .filter(
        (a) =>
          a.status === AppointmentStatus.PENDING ||
          a.status === AppointmentStatus.CONFIRMED,
      )
      .slice(0, 8);

    // ── Inventory ──────────────────────────────────────────────────────────────
    type CriticalProduct = {
      id: string;
      name: string;
      currentQuantity: number;
      minQuantity: number;
      unit: string;
      expiresAt: string | null;
      status: 'LOW' | 'EMPTY' | 'EXPIRING' | 'EXPIRED';
      categoryName: string | null;
    };

    const criticalProducts: CriticalProduct[] = [];
    let lowStockCount = 0;
    let expiringSoonCount = 0;

    for (const product of inventoryProducts) {
      const qty = Number(product.currentQuantity);
      const minQty = Number(product.minQuantity);
      const expiry = product.expiresAt;
      const isEmpty = qty <= 0;
      const isLow = qty > 0 && qty <= minQty;
      const isExpired = expiry !== null && expiry < now;
      const isExpiring =
        expiry !== null && !isExpired && expiry <= thirtyDaysLater;

      if (isEmpty || isLow) lowStockCount++;
      if (isExpired || isExpiring) expiringSoonCount++;

      if (
        (isEmpty || isLow || isExpired || isExpiring) &&
        criticalProducts.length < 5
      ) {
        criticalProducts.push({
          id: product.id,
          name: product.name,
          currentQuantity: qty,
          minQuantity: minQty,
          unit: product.unit,
          expiresAt: expiry ? this.isoDate(expiry) : null,
          status: isEmpty
            ? 'EMPTY'
            : isLow
              ? 'LOW'
              : isExpired
                ? 'EXPIRED'
                : 'EXPIRING',
          categoryName: product.category?.name ?? null,
        });
      }
    }

    // ── Finance month ──────────────────────────────────────────────────────────
    let monthIncome = 0;
    let monthExpenses = 0;
    let pendingReceivables = 0;

    for (const tx of financeTransactions) {
      const amount = Number(tx.amount);
      if (tx.type === FinancialTransactionType.INCOME) {
        if (tx.status === FinancialTransactionStatus.PAID)
          monthIncome += amount;
        else if (tx.status === FinancialTransactionStatus.PENDING)
          pendingReceivables += amount;
      } else if (
        tx.type === FinancialTransactionType.EXPENSE &&
        tx.status === FinancialTransactionStatus.PAID
      ) {
        monthExpenses += amount;
      }
    }

    // ── Patients without return ────────────────────────────────────────────────
    const patientsWithFutureSet = new Set(
      patientsWithFuture.map(
        (p) => `${p.patientName}|${p.patientPhone ?? ''}`,
      ),
    );

    const noReturnAll = patientsLastVisit.filter((p) => {
      const lastDate = p._max.appointmentDate;
      const key = `${p.patientName}|${p.patientPhone ?? ''}`;
      return (
        lastDate !== null &&
        lastDate < sixtyDaysAgo &&
        !patientsWithFutureSet.has(key)
      );
    });

    const withoutReturnCount = noReturnAll.length;
    const noReturnExamples = noReturnAll.slice(0, 5).map((p) => ({
      patientName: p.patientName,
      patientPhone: p.patientPhone,
      lastVisit: p._max.appointmentDate ?? null,
    }));

    // ── Recommended actions ────────────────────────────────────────────────────
    const actions: Array<{
      type: string;
      title: string;
      description: string;
      priority: ActionPriority;
      href: string;
    }> = [];

    if (todayPending > 0) {
      actions.push({
        type: 'TODAY_SCHEDULE',
        title: 'Confirmar agendamentos de hoje',
        description: `${todayPending} ${todayPending === 1 ? 'consulta aguarda' : 'consultas aguardam'} confirmação para hoje.`,
        priority: 'HIGH',
        href: '/app/agendamentos',
      });
    }

    if (pendingPaymentsCount > 0) {
      actions.push({
        type: 'PENDING_PAYMENT',
        title: 'Cobrar consultas pendentes',
        description: `${pendingPaymentsCount} ${pendingPaymentsCount === 1 ? 'consulta concluída aguarda' : 'consultas concluídas aguardam'} pagamento.`,
        priority: pendingPaymentsCount >= 3 ? 'HIGH' : 'MEDIUM',
        href: '/app/financeiro',
      });
    }

    const stockAlerts = lowStockCount + expiringSoonCount;
    if (stockAlerts > 0) {
      actions.push({
        type: lowStockCount > 0 ? 'LOW_STOCK' : 'EXPIRING_STOCK',
        title: 'Atenção no estoque',
        description: `${stockAlerts} ${stockAlerts === 1 ? 'produto precisa' : 'produtos precisam'} de atenção.`,
        priority: 'MEDIUM',
        href: '/app/estoque',
      });
    }

    if (withoutReturnCount > 0) {
      actions.push({
        type: 'PATIENT_FOLLOW_UP',
        title: 'Pacientes para retorno',
        description: `${withoutReturnCount} ${withoutReturnCount === 1 ? 'paciente' : 'pacientes'} sem consulta há mais de 60 dias.`,
        priority: 'LOW',
        href: '/app/pacientes',
      });
    }

    return {
      today: {
        date: todayStr,
        appointmentsTotal: todayTotal,
        appointmentsConfirmed: todayConfirmed,
        appointmentsPending: todayPending,
        appointmentsCompleted: todayCompleted,
        appointmentsCanceledOrNoShow: todayCanceledOrNoShow,
        pendingPaymentsCount,
        pendingPaymentsAmountCents,
      },
      upcomingToday: upcomingToday.map((a) => ({
        id: a.id,
        patientName: a.patientName,
        startTime: a.startTime,
        status: a.status,
        paymentStatus: a.paymentStatus,
        profileName: a.profile.displayName,
        serviceName: a.service?.name ?? null,
      })),
      pendingPaymentAppointments: pendingPaymentAppts.map((a) => ({
        id: a.id,
        patientName: a.patientName,
        patientPhone: a.patientPhone,
        appointmentDate: a.appointmentDate,
        startTime: a.startTime,
        estimatedAmountCents: a.estimatedAmountCents,
        paidAmountCents: a.paidAmountCents,
        paymentStatus: a.paymentStatus,
        profileName: a.profile.displayName,
        serviceName: a.service?.name ?? null,
      })),
      recentCanceled: recentCanceled.map((a) => ({
        id: a.id,
        patientName: a.patientName,
        appointmentDate: a.appointmentDate,
        startTime: a.startTime,
        cancellationReason: a.cancellationReason,
        profileName: a.profile.displayName,
      })),
      inventory: {
        lowStockCount,
        expiringSoonCount,
        criticalProducts,
      },
      finance: {
        monthIncome,
        monthExpenses,
        monthNet: monthIncome - monthExpenses,
        pendingReceivables,
      },
      patients: {
        withoutReturnCount,
        examples: noReturnExamples,
      },
      actions,
    };
  }

  private isoDate(date: Date): string {
    return date.toISOString().split('T')[0];
  }
}
