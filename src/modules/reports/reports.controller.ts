import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuditAction } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequiresBillingAccess } from '../../common/decorators/requires-billing-access.decorator';
import { RequirePlanFeature } from '../../common/decorators/require-plan-feature.decorator';
import { PlanFeature } from '../billing/plan-feature.types';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantScoped } from '../../common/decorators/tenant-scoped.decorator';
import { AccessPolicyService } from '../../common/services/access-policy.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthUser } from '../../common/types/auth-user.type';
import { ReportsService } from './reports.service';
import {
  AppointmentsReportQueryDto,
  FinanceReportQueryDto,
  InventoryReportQueryDto,
  InvoicesReportQueryDto,
} from './dto/report-query.dto';
import type { ReportPreviewResponse } from './dto/report-preview-response.dto';
import { brazilTodayIso } from '../../common/utils/brazil-timezone';

function sendCsv(res: Response, csv: string, filename: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(csv);
}

function safeFilename(base: string): string {
  return `${base}_${brazilTodayIso()}.csv`;
}

@Controller('reports')
@TenantScoped()
@RequiresBillingAccess()
@RequirePlanFeature(PlanFeature.REPORTS)
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly accessPolicy: AccessPolicyService,
    private readonly auditLog: AuditLogService,
  ) {}

  // ── Finance ──────────────────────────────────────────────────────────────

  @Get('finance/export')
  @Roles('OWNER')
  async exportFinance(
    @CurrentUser() user: AuthUser,
    @Query() query: FinanceReportQueryDto,
    @Res() res: Response,
  ) {
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    const csv = await this.reports.exportFinance(clinicId, query);

    void this.auditLog.log({
      actorUserId: user.id,
      clinicId,
      action: AuditAction.REPORT_EXPORTED,
      entityType: 'Report',
      metadata: {
        report: 'finance',
        startDate: query.startDate,
        endDate: query.endDate,
        type: query.type,
        status: query.status,
      },
    });

    sendCsv(res, csv, safeFilename('relatorio_financeiro'));
  }

  @Get('finance/preview')
  @Roles('OWNER')
  async previewFinance(
    @CurrentUser() user: AuthUser,
    @Query() query: FinanceReportQueryDto,
  ): Promise<ReportPreviewResponse> {
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    return this.reports.previewFinance(clinicId, query);
  }

  // ── Appointments ──────────────────────────────────────────────────────────

  @Get('appointments/export')
  @Roles('OWNER', 'ASSISTANT')
  async exportAppointments(
    @CurrentUser() user: AuthUser,
    @Query() query: AppointmentsReportQueryDto,
    @Res() res: Response,
  ) {
    const clinicId = this.accessPolicy.assertOwnerOrAssistantAccess(user);
    const csv = await this.reports.exportAppointments(clinicId, query);

    void this.auditLog.log({
      actorUserId: user.id,
      clinicId,
      action: AuditAction.REPORT_EXPORTED,
      entityType: 'Report',
      metadata: {
        report: 'appointments',
        startDate: query.startDate,
        endDate: query.endDate,
        status: query.status,
        profileId: query.profileId,
      },
    });

    sendCsv(res, csv, safeFilename('relatorio_agendamentos'));
  }

  @Get('appointments/preview')
  @Roles('OWNER', 'ASSISTANT')
  async previewAppointments(
    @CurrentUser() user: AuthUser,
    @Query() query: AppointmentsReportQueryDto,
  ): Promise<ReportPreviewResponse> {
    const clinicId = this.accessPolicy.assertOwnerOrAssistantAccess(user);
    return this.reports.previewAppointments(clinicId, query);
  }

  // ── Inventory ─────────────────────────────────────────────────────────────

  @Get('inventory/export')
  @Roles('OWNER', 'ASSISTANT')
  async exportInventory(
    @CurrentUser() user: AuthUser,
    @Query() query: InventoryReportQueryDto,
    @Res() res: Response,
  ) {
    const clinicId = this.accessPolicy.assertOwnerOrAssistantAccess(user);
    const csv = await this.reports.exportInventory(clinicId, query);

    void this.auditLog.log({
      actorUserId: user.id,
      clinicId,
      action: AuditAction.REPORT_EXPORTED,
      entityType: 'Report',
      metadata: {
        report: 'inventory',
        categoryId: query.categoryId,
        status: query.status,
      },
    });

    sendCsv(res, csv, safeFilename('relatorio_estoque'));
  }

  @Get('inventory/preview')
  @Roles('OWNER', 'ASSISTANT')
  async previewInventory(
    @CurrentUser() user: AuthUser,
    @Query() query: InventoryReportQueryDto,
  ): Promise<ReportPreviewResponse> {
    const clinicId = this.accessPolicy.assertOwnerOrAssistantAccess(user);
    return this.reports.previewInventory(clinicId, query);
  }

  // ── Invoices ──────────────────────────────────────────────────────────────

  @Get('invoices/export')
  @Roles('OWNER', 'ASSISTANT')
  async exportInvoices(
    @CurrentUser() user: AuthUser,
    @Query() query: InvoicesReportQueryDto,
    @Res() res: Response,
  ) {
    const clinicId = this.accessPolicy.assertOwnerOrAssistantAccess(user);
    const csv = await this.reports.exportInvoices(clinicId, query);

    void this.auditLog.log({
      actorUserId: user.id,
      clinicId,
      action: AuditAction.REPORT_EXPORTED,
      entityType: 'Report',
      metadata: {
        report: 'invoices',
        status: query.status,
        startDate: query.startDate,
        endDate: query.endDate,
      },
    });

    sendCsv(res, csv, safeFilename('relatorio_notas_fiscais'));
  }

  @Get('invoices/preview')
  @Roles('OWNER', 'ASSISTANT')
  async previewInvoices(
    @CurrentUser() user: AuthUser,
    @Query() query: InvoicesReportQueryDto,
  ): Promise<ReportPreviewResponse> {
    const clinicId = this.accessPolicy.assertOwnerOrAssistantAccess(user);
    return this.reports.previewInvoices(clinicId, query);
  }
}
