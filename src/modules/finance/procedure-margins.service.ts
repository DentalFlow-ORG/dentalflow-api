import { Injectable } from '@nestjs/common';
import {
  AppointmentStatus,
  FinancialTransactionStatus,
  FinancialTransactionType,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ProcedureMarginsQueryDto } from './dto/procedure-margins-query.dto';

export type ProcedureMarginStatus = 'HEALTHY' | 'ATTENTION' | 'INSUFFICIENT_DATA';

type PeriodBounds = { from: Date; to: Date };

@Injectable()
export class ProcedureMarginsService {
  constructor(private readonly prisma: PrismaService) {}

  async getMargins(clinicId: string, dto: ProcedureMarginsQueryDto) {
    const period = this.resolvePeriod(dto);

    const appointments = await this.prisma.appointment.findMany({
      where: {
        clinicId,
        serviceId: { not: null },
        appointmentDate: { gte: period.from, lte: period.to },
        ...(dto.profileId ? { profileId: dto.profileId } : {}),
      },
      select: {
        id: true,
        serviceId: true,
        service: {
          select: { id: true, name: true, estimatedDirectCostCents: true },
        },
        status: true,
        estimatedAmountCents: true,
        paidAmountCents: true,
      },
    });

    const appointmentIds = appointments.map((a) => a.id);

    const transactions =
      appointmentIds.length > 0
        ? await this.prisma.financialTransaction.findMany({
            where: {
              clinicId,
              type: FinancialTransactionType.INCOME,
              status: FinancialTransactionStatus.PAID,
              appointmentId: { in: appointmentIds },
            },
            select: { appointmentId: true, amount: true },
          })
        : [];

    const txMap = new Map<string, number>();
    for (const tx of transactions) {
      if (tx.appointmentId) {
        txMap.set(tx.appointmentId, Math.round(Number(tx.amount) * 100));
      }
    }

    type ServiceGroup = {
      serviceId: string;
      serviceName: string;
      estimatedDirectCostCents: number | null;
      totalAppointments: number;
      completedAppointments: number;
      canceledOrNoShowCount: number;
      grossRevenueCents: number;
    };

    const serviceMap = new Map<string, ServiceGroup>();

    for (const appt of appointments) {
      if (!appt.serviceId || !appt.service) continue;

      if (!serviceMap.has(appt.serviceId)) {
        serviceMap.set(appt.serviceId, {
          serviceId: appt.serviceId,
          serviceName: appt.service.name,
          estimatedDirectCostCents: appt.service.estimatedDirectCostCents,
          totalAppointments: 0,
          completedAppointments: 0,
          canceledOrNoShowCount: 0,
          grossRevenueCents: 0,
        });
      }

      const group = serviceMap.get(appt.serviceId)!;
      group.totalAppointments++;

      if (appt.status === AppointmentStatus.COMPLETED) {
        group.completedAppointments++;
      } else if (
        appt.status === AppointmentStatus.CANCELED ||
        appt.status === AppointmentStatus.NO_SHOW
      ) {
        group.canceledOrNoShowCount++;
      }

      group.grossRevenueCents += this.computeAppointmentRevenue(appt, txMap);
    }

    const statusOrder: Record<ProcedureMarginStatus, number> = {
      ATTENTION: 0,
      HEALTHY: 1,
      INSUFFICIENT_DATA: 2,
    };

    const items = Array.from(serviceMap.values())
      .map((group) => {
        const status = this.determineStatus(
          group.totalAppointments,
          group.completedAppointments,
          group.canceledOrNoShowCount,
        );
        const avgRevenueCents =
          group.completedAppointments > 0
            ? Math.round(group.grossRevenueCents / group.completedAppointments)
            : 0;

        const costPerAppt = group.estimatedDirectCostCents;
        const itemCostCents =
          costPerAppt !== null
            ? costPerAppt * group.completedAppointments
            : null;
        const itemProfitCents =
          itemCostCents !== null
            ? group.grossRevenueCents - itemCostCents
            : null;
        const itemMarginPercent =
          itemProfitCents !== null && group.grossRevenueCents > 0
            ? Number(((itemProfitCents / group.grossRevenueCents) * 100).toFixed(2))
            : null;

        return {
          serviceId: group.serviceId,
          serviceName: group.serviceName,
          totalAppointments: group.totalAppointments,
          completedAppointments: group.completedAppointments,
          canceledOrNoShowCount: group.canceledOrNoShowCount,
          grossRevenueCents: group.grossRevenueCents,
          estimatedDirectCostCents: itemCostCents,
          estimatedProfitCents: itemProfitCents,
          marginPercent: itemMarginPercent,
          avgRevenueCents,
          status,
        };
      })
      .sort((a, b) => {
        const diff = statusOrder[a.status] - statusOrder[b.status];
        return diff !== 0 ? diff : b.grossRevenueCents - a.grossRevenueCents;
      });

    const allHaveCost =
      items.length > 0 && items.every((i) => i.estimatedDirectCostCents !== null);
    const totalGrossRevenue = items.reduce((s, i) => s + i.grossRevenueCents, 0);
    const totalCostCents = allHaveCost
      ? items.reduce((s, i) => s + (i.estimatedDirectCostCents ?? 0), 0)
      : null;
    const totalProfitCents =
      totalCostCents !== null ? totalGrossRevenue - totalCostCents : null;
    const totalMarginPercent =
      totalProfitCents !== null && totalGrossRevenue > 0
        ? Number(((totalProfitCents / totalGrossRevenue) * 100).toFixed(2))
        : null;

    const totals = {
      totalAppointments: items.reduce((s, i) => s + i.totalAppointments, 0),
      completedAppointments: items.reduce((s, i) => s + i.completedAppointments, 0),
      grossRevenueCents: totalGrossRevenue,
      estimatedDirectCostCents: totalCostCents,
      estimatedProfitCents: totalProfitCents,
      marginPercent: totalMarginPercent,
    };

    return {
      period: {
        from: period.from.toISOString().slice(0, 10),
        to: period.to.toISOString().slice(0, 10),
      },
      items,
      totals,
      costDataAvailable: allHaveCost,
      limitation: allHaveCost
        ? null
        : 'Custo direto não configurado. Adicione custos de materiais por procedimento para ver a margem real.',
    };
  }

  public resolvePeriod(dto: ProcedureMarginsQueryDto): PeriodBounds {
    if (dto.month) {
      const [year, month] = dto.month.split('-').map(Number);
      return {
        from: new Date(Date.UTC(year, month - 1, 1)),
        to: new Date(Date.UTC(year, month, 0)),
      };
    }
    if (dto.startDate && dto.endDate) {
      return {
        from: new Date(`${dto.startDate}T00:00:00.000Z`),
        to: new Date(`${dto.endDate}T23:59:59.999Z`),
      };
    }
    const now = new Date();
    return {
      from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)),
    };
  }

  public determineStatus(
    total: number,
    completed: number,
    canceledOrNoShow: number,
  ): ProcedureMarginStatus {
    if (total < 3) return 'INSUFFICIENT_DATA';
    if (completed === 0) return 'ATTENTION';
    if (canceledOrNoShow / total >= 0.4) return 'ATTENTION';
    return 'HEALTHY';
  }

  public computeAppointmentRevenue(
    appt: {
      id: string;
      status: AppointmentStatus;
      paidAmountCents: number | null;
      estimatedAmountCents: number | null;
    },
    txMap: Map<string, number>,
  ): number {
    if (
      appt.status === AppointmentStatus.CANCELED ||
      appt.status === AppointmentStatus.NO_SHOW
    ) {
      return 0;
    }
    const tx = txMap.get(appt.id);
    if (tx !== undefined) return tx;
    if (appt.paidAmountCents != null && appt.paidAmountCents > 0) {
      return appt.paidAmountCents;
    }
    if (
      appt.status === AppointmentStatus.COMPLETED &&
      appt.estimatedAmountCents != null &&
      appt.estimatedAmountCents > 0
    ) {
      return appt.estimatedAmountCents;
    }
    return 0;
  }
}
