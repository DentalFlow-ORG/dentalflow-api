import {
  Controller,
  Get,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuditAction } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequiresBillingAccess } from '../../common/decorators/requires-billing-access.decorator';
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
  LeadsReportQueryDto,
} from './dto/report-query.dto';

function sendCsv(res: Response, csv: string, filename: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(csv);
}

function safeFilename(base: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return `${base}_${date}.csv`;
}

@Controller('reports')
@TenantScoped()
@RequiresBillingAccess()
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly accessPolicy: AccessPolicyService,
    private readonly auditLog: AuditLogService,
  ) {}

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
      metadata: { report: 'inventory', categoryId: query.categoryId, status: query.status },
    });

    sendCsv(res, csv, safeFilename('relatorio_estoque'));
  }

  @Get('leads/export')
  @Roles('OWNER', 'ASSISTANT')
  async exportLeads(
    @CurrentUser() user: AuthUser,
    @Query() query: LeadsReportQueryDto,
    @Res() res: Response,
  ) {
    const clinicId = this.accessPolicy.assertOwnerOrAssistantAccess(user);
    const csv = await this.reports.exportLeads(clinicId, query);

    void this.auditLog.log({
      actorUserId: user.id,
      clinicId,
      action: AuditAction.REPORT_EXPORTED,
      entityType: 'Report',
      metadata: {
        report: 'leads',
        status: query.status,
        source: query.source,
        startDate: query.startDate,
        endDate: query.endDate,
      },
    });

    sendCsv(res, csv, safeFilename('relatorio_leads'));
  }

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
}
