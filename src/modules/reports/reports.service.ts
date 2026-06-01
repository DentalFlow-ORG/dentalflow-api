import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { validateReportDateRange } from '../../common/utils/date-range.utils';
import {
  brazilTodayIso,
  parseBrazilDateOnlyToUtcRange,
} from '../../common/utils/brazil-timezone';
import {
  AppointmentsReportQueryDto,
  FinanceReportQueryDto,
  InventoryReportQueryDto,
  InvoicesReportQueryDto,
  LeadsReportQueryDto,
} from './dto/report-query.dto';

const EXPORT_LIMIT = 5000;

// ── CSV helpers ──────────────────────────────────────────────────────────────

function csvValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  // Prevent formula injection (Excel/Sheets interpret these as formulas)
  if (/^[=+\-@\t\r]/.test(str)) return `'${str}`;
  if (str.includes(';') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const BOM = '﻿';
  const sep = ';';
  const lines = [
    headers.map(csvValue).join(sep),
    ...rows.map((row) => row.map(csvValue).join(sep)),
  ];
  return BOM + lines.join('\r\n');
}

function formatDateBR(date: Date | string | null | undefined): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function formatDateTimeBR(date: Date | string | null | undefined): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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

// Kept for backward compatibility within this file only.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function parseDate(str: string | undefined): Date | undefined {
  return parseDateOnly(str);
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

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async exportFinance(clinicId: string, query: FinanceReportQueryDto): Promise<string> {
    validateReportDateRange(query.startDate, query.endDate, { allowFuture: false });
    const where: Prisma.FinancialTransactionWhereInput = {
      clinicId,
      ...(query.startDate || query.endDate
        ? {
            transactionDate: {
              ...(query.startDate ? { gte: parseDateOnly(query.startDate) } : {}),
              ...(query.endDate ? { lt: parseDateOnlyEnd(query.endDate) } : {}),
            },
          }
        : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    };

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

  // ── Appointments report ──────────────────────────────────────────────────

  async exportAppointments(clinicId: string, query: AppointmentsReportQueryDto): Promise<string> {
    validateReportDateRange(query.startDate, query.endDate, { allowFuture: true });
    const where: Prisma.AppointmentWhereInput = {
      clinicId,
      ...(query.startDate || query.endDate
        ? {
            appointmentDate: {
              ...(query.startDate ? { gte: parseDateOnly(query.startDate) } : {}),
              ...(query.endDate ? { lt: parseDateOnlyEnd(query.endDate) } : {}),
            },
          }
        : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.profileId ? { profileId: query.profileId } : {}),
    };

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
      a.paymentMethod ? (PAYMENT_METHOD_LABELS[a.paymentMethod] ?? a.paymentMethod) : '',
      centsToDecimal(a.estimatedAmountCents),
      centsToDecimal(a.paidAmountCents),
    ]);

    return buildCsv(headers, data);
  }

  // ── Inventory report ─────────────────────────────────────────────────────

  async exportInventory(clinicId: string, query: InventoryReportQueryDto): Promise<string> {
    const EXPIRY_WARNING_DAYS = 30;

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

    const computeStatus = (p: {
      isActive: boolean;
      currentQuantity: Prisma.Decimal;
      minQuantity: Prisma.Decimal;
      expiresAt: Date | null;
    }): string => {
      if (!p.isActive) return 'INACTIVE';
      // expiresAt is stored as UTC midnight of the calendar date. Use UTC midnight
      // of the Brazil today so an item expiring "today Brazil" is not flagged as
      // EXPIRED at 00:01-02:59 UTC when Brazil is still the previous day.
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
    };

    const filtered = products
      .map((p) => ({ ...p, _status: computeStatus(p) }))
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

  // ── Leads report ─────────────────────────────────────────────────────────

  async exportLeads(clinicId: string, query: LeadsReportQueryDto): Promise<string> {
    validateReportDateRange(query.startDate, query.endDate, { allowFuture: false });
    const SOURCE_LABELS: Record<string, string> = {
      PROFILE_PAGE: 'Página de perfil',
      MANUAL: 'Manual',
      IMPORT: 'Importação',
      REFERRAL: 'Indicação',
      WEBSITE: 'Site',
      WHATSAPP: 'WhatsApp',
      INSTAGRAM: 'Instagram',
      GOOGLE: 'Google',
      OTHER: 'Outro',
    };

    const STATUS_LABELS: Record<string, string> = {
      NEW: 'Novo',
      CONTACTED: 'Em contato',
      SCHEDULED: 'Agendado',
      CONVERTED: 'Convertido',
      LOST: 'Perdido',
      ARCHIVED: 'Arquivado',
    };

    const where: Prisma.LeadWhereInput = {
      clinicId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.source ? { source: query.source } : {}),
      ...(query.startDate || query.endDate
        ? {
            // createdAt is a UTC timestamp — use Brazil midnight so "from June 1"
            // correctly starts at June 1 00:00 Brazil (03:00 UTC).
            createdAt: {
              ...(query.startDate
                ? { gte: parseBrazilDateOnlyToUtcRange(query.startDate).start }
                : {}),
              ...(query.endDate
                ? { lt: parseBrazilDateOnlyToUtcRange(query.endDate).end }
                : {}),
            },
          }
        : {}),
    };

    const rows = await this.prisma.lead.findMany({
      where,
      select: {
        name: true,
        phone: true,
        email: true,
        source: true,
        status: true,
        nextFollowUpAt: true,
        createdAt: true,
        assignedTo: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: EXPORT_LIMIT,
    });

    const headers = [
      'Nome',
      'Telefone',
      'E-mail',
      'Origem',
      'Status',
      'Responsável',
      'Próximo follow-up',
      'Criado em',
    ];

    const data = rows.map((l) => [
      l.name,
      l.phone ?? '',
      l.email ?? '',
      SOURCE_LABELS[l.source] ?? l.source,
      STATUS_LABELS[l.status] ?? l.status,
      l.assignedTo ? `${l.assignedTo.firstName} ${l.assignedTo.lastName}` : '',
      formatDateBR(l.nextFollowUpAt),
      formatDateTimeBR(l.createdAt),
    ]);

    return buildCsv(headers, data);
  }

  // ── Invoices report ──────────────────────────────────────────────────────

  async exportInvoices(clinicId: string, query: InvoicesReportQueryDto): Promise<string> {
    validateReportDateRange(query.startDate, query.endDate, { allowFuture: false });
    const STATUS_LABELS: Record<string, string> = {
      DRAFT: 'Rascunho',
      READY_TO_ISSUE: 'Pronto para emitir',
      SIMULATED: 'Simulado',
      PROCESSING: 'Processando',
      ISSUED: 'Emitido',
      FAILED: 'Falhou',
      CANCELED: 'Cancelado',
    };

    const where: Prisma.ServiceInvoiceWhereInput = {
      clinicId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.startDate || query.endDate
        ? {
            competenceDate: {
              ...(query.startDate ? { gte: parseDateOnly(query.startDate) } : {}),
              ...(query.endDate ? { lt: parseDateOnlyEnd(query.endDate) } : {}),
            },
          }
        : {}),
    };

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
      formatDateBR(i.simulatedIssueDate),
      i.serviceDescription ?? '',
      i.appointmentId ?? '',
      i.isLegalDocument ? '' : 'Registro interno — não substitui NF-e oficial',
    ]);

    return buildCsv(headers, data);
  }
}
