import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { validateReportDateRange } from '../../common/utils/date-range.utils';
import {
  BRAZIL_TIME_ZONE,
  brazilTodayIso,
} from '../../common/utils/brazil-timezone';
import {
  AppointmentsReportQueryDto,
  FinanceReportQueryDto,
  InventoryReportQueryDto,
  InvoicesReportQueryDto,
} from './dto/report-query.dto';
import type {
  ReportPreviewFilter,
  ReportPreviewPeriod,
  ReportPreviewResponse,
} from './dto/report-preview-response.dto';

export const EXPORT_LIMIT = 5000;

// ── CSV helpers ──────────────────────────────────────────────────────────────

function csvValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const str = String(value);

  // Prevent formula injection: Excel and Sheets execute a cell beginning with
  // any of these, and the value may be attacker-supplied (a patient chooses
  // their own name when booking). Prefixing with an apostrophe makes the cell
  // literal text.
  const guarded = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;

  // Quote *after* guarding, never instead of it. Returning early on the guard
  // used to skip this branch, so a hostile value carrying the separator split
  // into two cells and only the first was neutralised — the second reached the
  // spreadsheet as a live formula.
  if (
    guarded.includes(';') ||
    guarded.includes('"') ||
    guarded.includes('\n') ||
    guarded.includes('\r')
  ) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }

  return guarded;
}

function buildCsv(
  headers: string[],
  rows: (string | number | null | undefined)[][],
): string {
  const BOM = '﻿';
  const sep = ';';
  const lines = [
    headers.map(csvValue).join(sep),
    ...rows.map((row) => row.map(csvValue).join(sep)),
  ];
  return BOM + lines.join('\r\n');
}

/**
 * Formats a **calendar date** — a `@db.Date` column, which Prisma returns as
 * UTC midnight.
 *
 * Read in UTC, deliberately. Rendering UTC midnight in America/Sao_Paulo
 * (UTC-3) lands on 21:00 the previous evening, which showed every exported
 * date a day earlier than the one stored.
 */
function formatDateBR(date: Date | string | null | undefined): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
}

/**
 * Formats a **timestamp** — an instant, rather than a calendar date.
 *
 * Here the clinic's timezone genuinely applies: the reader wants the moment as
 * it happened locally.
 */
function formatTimestampBR(date: Date | string | null | undefined): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('pt-BR', { timeZone: BRAZIL_TIME_ZONE });
}

function formatTime(date: Date | string | null | undefined): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '';
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function centsToDecimal(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  return (cents / 100).toFixed(2).replace('.', ',');
}

function decimalToStr(val: Prisma.Decimal | null | undefined): string {
  if (val === null || val === undefined) return '';
  return Number(val).toFixed(3).replace('.', ',');
}

// For DATE-ONLY fields stored as UTC midnight (transactionDate, appointmentDate, competenceDate).
function parseDateOnly(str: string | undefined): Date | undefined {
  if (!str) return undefined;
  const [y, m, d] = str.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

// Exclusive end for DATE-ONLY fields: next UTC midnight.
function parseDateOnlyEnd(str: string | undefined): Date | undefined {
  if (!str) return undefined;
  const [y, m, d] = str.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1));
}

// ── Preview helpers ──────────────────────────────────────────────────────────

function isoToBR(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function buildPeriodLabel(startDate?: string, endDate?: string): string {
  if (startDate && endDate)
    return `${isoToBR(startDate)} até ${isoToBR(endDate)}`;
  if (startDate) return `A partir de ${isoToBR(startDate)}`;
  if (endDate) return `Até ${isoToBR(endDate)}`;
  return 'Sem filtro de período';
}

function buildPeriod(
  startDate?: string,
  endDate?: string,
): ReportPreviewPeriod | null {
  if (!startDate && !endDate) return null;
  return {
    startDate: startDate ?? null,
    endDate: endDate ?? null,
    label: buildPeriodLabel(startDate, endDate),
  };
}

// ── Finance report ───────────────────────────────────────────────────────────

const FINANCE_TYPE_LABELS: Record<string, string> = {
  INCOME: 'Receita',
  EXPENSE: 'Despesa',
};

const FINANCE_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Pendente',
  PAID: 'Pago',
  CANCELED: 'Cancelado',
};

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  CASH: 'Dinheiro',
  CREDIT_CARD: 'Cartão de crédito',
  DEBIT_CARD: 'Cartão de débito',
  PIX: 'Pix',
  BANK_TRANSFER: 'Transferência bancária',
  HEALTH_INSURANCE: 'Convênio',
  OTHER: 'Outro',
};

// ── Inventory status computation (reused by export and preview) ──────────────

const EXPIRY_WARNING_DAYS = 30;

export interface InventoryStatusInput {
  isActive: boolean;
  currentQuantity: Prisma.Decimal;
  minQuantity: Prisma.Decimal;
  expiresAt: Date | null;
}

export function computeInventoryStatus(p: InventoryStatusInput): string {
  if (!p.isActive) return 'INACTIVE';
  const today = new Date(`${brazilTodayIso()}T00:00:00.000Z`);
  if (p.expiresAt) {
    const exp = new Date(p.expiresAt);
    if (exp < today) return 'EXPIRED';
    const days = Math.ceil((exp.getTime() - today.getTime()) / 86_400_000);
    if (days <= EXPIRY_WARNING_DAYS) return 'EXPIRING';
  }
  const cur = Number(p.currentQuantity);
  if (cur === 0) return 'EMPTY';
  const min = Number(p.minQuantity);
  if (min > 0 && cur <= min) return 'LOW';
  return 'ACTIVE';
}

// ── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Finance export ─────────────────────────────────────────────────────────

  async exportFinance(
    clinicId: string,
    query: FinanceReportQueryDto,
  ): Promise<string> {
    validateReportDateRange(query.startDate, query.endDate, {
      allowFuture: false,
    });
    const where = this.buildFinanceWhere(clinicId, query);

    const rows = await this.prisma.financialTransaction.findMany({
      where,
      include: {
        category: true,
        service: { select: { name: true } },
        profile: { select: { displayName: true } },
      },
      orderBy: [{ transactionDate: 'desc' }, { createdAt: 'desc' }],
      take: EXPORT_LIMIT,
    });

    const headers = [
      'Data',
      'Tipo',
      'Status',
      'Descrição',
      'Categoria',
      'Valor (R$)',
      'Serviço',
      'Profissional',
    ];

    const data = rows.map((t) => [
      formatDateBR(t.transactionDate),
      FINANCE_TYPE_LABELS[t.type] ?? t.type,
      FINANCE_STATUS_LABELS[t.status] ?? t.status,
      t.description ?? '',
      t.category?.name ?? '',
      Number(t.amount).toFixed(2).replace('.', ','),
      t.service?.name ?? '',
      t.profile?.displayName ?? '',
    ]);

    return buildCsv(headers, data);
  }

  // ── Finance preview ────────────────────────────────────────────────────────

  async previewFinance(
    clinicId: string,
    query: FinanceReportQueryDto,
  ): Promise<ReportPreviewResponse> {
    validateReportDateRange(query.startDate, query.endDate, {
      allowFuture: false,
    });
    const where = this.buildFinanceWhere(clinicId, query);

    const [recordCount, clinic] = await Promise.all([
      this.prisma.financialTransaction.count({ where }),
      this.prisma.clinic.findUniqueOrThrow({
        where: { id: clinicId },
        select: { name: true },
      }),
    ]);

    const filters: ReportPreviewFilter[] = [];
    if (query.type) {
      filters.push({
        label: 'Tipo',
        value: FINANCE_TYPE_LABELS[query.type] ?? query.type,
      });
    }
    if (query.status) {
      filters.push({
        label: 'Status',
        value: FINANCE_STATUS_LABELS[query.status] ?? query.status,
      });
    }
    if (query.categoryId) {
      filters.push({ label: 'Categoria', value: query.categoryId });
    }

    return {
      reportType: 'finance',
      reportTitle: 'Relatório financeiro',
      clinic: { name: clinic.name, document: null },
      generatedAt: new Date().toISOString(),
      filters,
      period: buildPeriod(query.startDate, query.endDate),
      recordCount,
      maxRecords: EXPORT_LIMIT,
      isTruncated: recordCount > EXPORT_LIMIT,
      exportFormat: 'CSV',
      empty: recordCount === 0,
      previewNote: null,
    };
  }

  private buildFinanceWhere(
    clinicId: string,
    query: FinanceReportQueryDto,
  ): Prisma.FinancialTransactionWhereInput {
    return {
      clinicId,
      ...(query.startDate || query.endDate
        ? {
            transactionDate: {
              ...(query.startDate
                ? { gte: parseDateOnly(query.startDate) }
                : {}),
              ...(query.endDate ? { lt: parseDateOnlyEnd(query.endDate) } : {}),
            },
          }
        : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    };
  }

  // ── Appointments export ──────────────────────────────────────────────────

  async exportAppointments(
    clinicId: string,
    query: AppointmentsReportQueryDto,
  ): Promise<string> {
    validateReportDateRange(query.startDate, query.endDate, {
      allowFuture: true,
    });
    const where = this.buildAppointmentsWhere(clinicId, query);

    const rows = await this.prisma.appointment.findMany({
      where,
      select: {
        appointmentDate: true,
        startTime: true,
        patientName: true,
        status: true,
        paymentStatus: true,
        paymentMethod: true,
        estimatedAmountCents: true,
        paidAmountCents: true,
        profile: { select: { displayName: true } },
        service: { select: { name: true } },
      },
      orderBy: [{ appointmentDate: 'desc' }, { startTime: 'asc' }],
      take: EXPORT_LIMIT,
    });

    const STATUS_LABELS: Record<string, string> = {
      PENDING: 'Pendente',
      CONFIRMED: 'Confirmado',
      COMPLETED: 'Concluído',
      CANCELED: 'Cancelado',
      NO_SHOW: 'Não compareceu',
    };

    const PAY_STATUS_LABELS: Record<string, string> = {
      PAYMENT_PENDING: 'Pagamento pendente',
      PAID: 'Pago',
      PARTIALLY_PAID: 'Parcialmente pago',
      REFUNDED: 'Reembolsado',
      CANCELED: 'Cancelado',
    };

    const headers = [
      'Data',
      'Horário',
      'Paciente',
      'Profissional',
      'Serviço',
      'Status',
      'Status pagamento',
      'Forma de pagamento',
      'Valor estimado (R$)',
      'Valor pago (R$)',
    ];

    const data = rows.map((a) => [
      formatDateBR(a.appointmentDate),
      a.startTime ? formatTime(a.startTime) : '',
      a.patientName,
      a.profile.displayName,
      a.service?.name ?? '',
      STATUS_LABELS[a.status] ?? a.status,
      PAY_STATUS_LABELS[a.paymentStatus] ?? a.paymentStatus,
      a.paymentMethod
        ? (PAYMENT_METHOD_LABELS[a.paymentMethod] ?? a.paymentMethod)
        : '',
      centsToDecimal(a.estimatedAmountCents),
      centsToDecimal(a.paidAmountCents),
    ]);

    return buildCsv(headers, data);
  }

  // ── Appointments preview ──────────────────────────────────────────────────

  async previewAppointments(
    clinicId: string,
    query: AppointmentsReportQueryDto,
  ): Promise<ReportPreviewResponse> {
    validateReportDateRange(query.startDate, query.endDate, {
      allowFuture: true,
    });
    const where = this.buildAppointmentsWhere(clinicId, query);

    const APPT_STATUS_LABELS: Record<string, string> = {
      PENDING: 'Pendente',
      CONFIRMED: 'Confirmado',
      COMPLETED: 'Concluído',
      CANCELED: 'Cancelado',
      NO_SHOW: 'Não compareceu',
    };

    const [recordCount, clinic] = await Promise.all([
      this.prisma.appointment.count({ where }),
      this.prisma.clinic.findUniqueOrThrow({
        where: { id: clinicId },
        select: { name: true },
      }),
    ]);

    const filters: ReportPreviewFilter[] = [];
    if (query.status) {
      filters.push({
        label: 'Status',
        value: APPT_STATUS_LABELS[query.status] ?? query.status,
      });
    }
    if (query.profileId) {
      filters.push({ label: 'Profissional (ID)', value: query.profileId });
    }

    return {
      reportType: 'appointments',
      reportTitle: 'Relatório de agendamentos',
      clinic: { name: clinic.name, document: null },
      generatedAt: new Date().toISOString(),
      filters,
      period: buildPeriod(query.startDate, query.endDate),
      recordCount,
      maxRecords: EXPORT_LIMIT,
      isTruncated: recordCount > EXPORT_LIMIT,
      exportFormat: 'CSV',
      empty: recordCount === 0,
      previewNote: null,
    };
  }

  private buildAppointmentsWhere(
    clinicId: string,
    query: AppointmentsReportQueryDto,
  ): Prisma.AppointmentWhereInput {
    return {
      clinicId,
      ...(query.startDate || query.endDate
        ? {
            appointmentDate: {
              ...(query.startDate
                ? { gte: parseDateOnly(query.startDate) }
                : {}),
              ...(query.endDate ? { lt: parseDateOnlyEnd(query.endDate) } : {}),
            },
          }
        : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.profileId ? { profileId: query.profileId } : {}),
    };
  }

  // ── Inventory export ─────────────────────────────────────────────────────

  async exportInventory(
    clinicId: string,
    query: InventoryReportQueryDto,
  ): Promise<string> {
    const where: Prisma.StockProductWhereInput = {
      clinicId,
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    };

    const products = await this.prisma.stockProduct.findMany({
      where,
      include: { category: true },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      take: EXPORT_LIMIT,
    });

    const STATUS_PT: Record<string, string> = {
      ACTIVE: 'Normal',
      LOW: 'Estoque baixo',
      EMPTY: 'Zerado',
      EXPIRING: 'Vencimento próximo',
      EXPIRED: 'Vencido',
      INACTIVE: 'Inativo',
    };

    const filtered = products
      .map((p) => ({ ...p, _status: computeInventoryStatus(p) }))
      .filter((p) => (query.status ? p._status === query.status : true));

    const headers = [
      'Produto',
      'Categoria',
      'Qtd. atual',
      'Qtd. mínima',
      'Unidade',
      'Validade',
      'Status',
      'Fornecedor',
    ];

    const data = filtered.map((p) => [
      p.name,
      p.category?.name ?? '',
      decimalToStr(p.currentQuantity),
      decimalToStr(p.minQuantity),
      p.unit,
      formatDateBR(p.expiresAt),
      STATUS_PT[p._status] ?? p._status,
      p.supplier ?? '',
    ]);

    return buildCsv(headers, data);
  }

  // ── Inventory preview ─────────────────────────────────────────────────────

  async previewInventory(
    clinicId: string,
    query: InventoryReportQueryDto,
  ): Promise<ReportPreviewResponse> {
    const STATUS_PT: Record<string, string> = {
      ACTIVE: 'Normal',
      LOW: 'Estoque baixo',
      EMPTY: 'Zerado',
      EXPIRING: 'Vencimento próximo',
      EXPIRED: 'Vencido',
      INACTIVE: 'Inativo',
    };

    const where: Prisma.StockProductWhereInput = {
      clinicId,
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    };

    // Fetch all matching products without the export cap so we can compute
    // the exact post-filter count (status is computed in-memory from product fields).
    const [products, clinic] = await Promise.all([
      this.prisma.stockProduct.findMany({
        where,
        select: {
          isActive: true,
          currentQuantity: true,
          minQuantity: true,
          expiresAt: true,
        },
      }),
      this.prisma.clinic.findUniqueOrThrow({
        where: { id: clinicId },
        select: { name: true },
      }),
    ]);

    const filtered = products.filter((p) => {
      const status = computeInventoryStatus(p);
      return query.status ? status === query.status : true;
    });

    const recordCount = filtered.length;

    const filters: ReportPreviewFilter[] = [];
    if (query.categoryId) {
      filters.push({ label: 'Categoria (ID)', value: query.categoryId });
    }
    if (query.status) {
      filters.push({
        label: 'Status',
        value: STATUS_PT[query.status] ?? query.status,
      });
    }

    return {
      reportType: 'inventory',
      reportTitle: 'Relatório de estoque',
      clinic: { name: clinic.name, document: null },
      generatedAt: new Date().toISOString(),
      filters,
      period: null,
      recordCount,
      maxRecords: EXPORT_LIMIT,
      isTruncated: recordCount > EXPORT_LIMIT,
      exportFormat: 'CSV',
      empty: recordCount === 0,
      previewNote: null,
    };
  }

  // ── Invoices export ──────────────────────────────────────────────────────

  async exportInvoices(
    clinicId: string,
    query: InvoicesReportQueryDto,
  ): Promise<string> {
    validateReportDateRange(query.startDate, query.endDate, {
      allowFuture: false,
    });
    const STATUS_LABELS: Record<string, string> = {
      DRAFT: 'Rascunho',
      READY_TO_ISSUE: 'Pronto para emitir',
      SIMULATED: 'Simulado',
      PROCESSING: 'Processando',
      ISSUED: 'Emitido',
      FAILED: 'Falhou',
      CANCELED: 'Cancelado',
    };

    const where = this.buildInvoicesWhere(clinicId, query);

    const rows = await this.prisma.serviceInvoice.findMany({
      where,
      select: {
        id: true,
        invoiceNumber: true,
        customerName: true,
        amountCents: true,
        status: true,
        competenceDate: true,
        simulatedIssueDate: true,
        serviceDescription: true,
        appointmentId: true,
        environment: true,
        isLegalDocument: true,
      },
      orderBy: { competenceDate: 'desc' },
      take: EXPORT_LIMIT,
    });

    const headers = [
      'ID interno',
      'Número NF',
      'Cliente',
      'Valor (R$)',
      'Status',
      'Competência',
      'Data emissão (simulada)',
      'Descrição do serviço',
      'Agendamento vinculado',
      'Obs.',
    ];

    const data = rows.map((i) => [
      i.id,
      i.invoiceNumber ?? '',
      i.customerName,
      centsToDecimal(i.amountCents),
      STATUS_LABELS[i.status] ?? i.status,
      formatDateBR(i.competenceDate),
      formatTimestampBR(i.simulatedIssueDate),
      i.serviceDescription ?? '',
      i.appointmentId ?? '',
      i.isLegalDocument ? '' : 'Registro interno — não substitui NF-e oficial',
    ]);

    return buildCsv(headers, data);
  }

  // ── Invoices preview ──────────────────────────────────────────────────────

  async previewInvoices(
    clinicId: string,
    query: InvoicesReportQueryDto,
  ): Promise<ReportPreviewResponse> {
    validateReportDateRange(query.startDate, query.endDate, {
      allowFuture: false,
    });
    const where = this.buildInvoicesWhere(clinicId, query);

    const INVOICE_STATUS_LABELS: Record<string, string> = {
      DRAFT: 'Rascunho',
      READY_TO_ISSUE: 'Pronto para emitir',
      SIMULATED: 'Simulado',
      PROCESSING: 'Processando',
      ISSUED: 'Emitido',
      FAILED: 'Falhou',
      CANCELED: 'Cancelado',
    };

    const [recordCount, clinic] = await Promise.all([
      this.prisma.serviceInvoice.count({ where }),
      this.prisma.clinic.findUniqueOrThrow({
        where: { id: clinicId },
        select: { name: true },
      }),
    ]);

    const filters: ReportPreviewFilter[] = [];
    if (query.status) {
      filters.push({
        label: 'Status',
        value: INVOICE_STATUS_LABELS[query.status] ?? query.status,
      });
    }

    return {
      reportType: 'invoices',
      reportTitle: 'Relatório de notas fiscais',
      clinic: { name: clinic.name, document: null },
      generatedAt: new Date().toISOString(),
      filters,
      period: buildPeriod(query.startDate, query.endDate),
      recordCount,
      maxRecords: EXPORT_LIMIT,
      isTruncated: recordCount > EXPORT_LIMIT,
      exportFormat: 'CSV',
      empty: recordCount === 0,
      previewNote: null,
    };
  }

  private buildInvoicesWhere(
    clinicId: string,
    query: InvoicesReportQueryDto,
  ): Prisma.ServiceInvoiceWhereInput {
    return {
      clinicId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.startDate || query.endDate
        ? {
            competenceDate: {
              ...(query.startDate
                ? { gte: parseDateOnly(query.startDate) }
                : {}),
              ...(query.endDate ? { lt: parseDateOnlyEnd(query.endDate) } : {}),
            },
          }
        : {}),
    };
  }
}
