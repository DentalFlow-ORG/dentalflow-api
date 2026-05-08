import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequiresBillingAccess } from '../../common/decorators/requires-billing-access.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantScoped } from '../../common/decorators/tenant-scoped.decorator';
import { AccessPolicyService } from '../../common/services/access-policy.service';
import { AuthUser } from '../../common/types/auth-user.type';
import {
  CancelInvoiceDto,
  CreateServiceInvoiceDto,
  ListInvoicesDto,
  UpdateServiceInvoiceDto,
} from './dto/invoice.dto';
import { UpsertFiscalProfileDto } from './dto/upsert-fiscal-profile.dto';
import { FiscalService } from './fiscal.service';

@Controller('clinic')
@TenantScoped()
@Roles('OWNER', 'ASSISTANT')
@RequiresBillingAccess()
export class FiscalController {
  constructor(
    private readonly fiscalService: FiscalService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  @Get('fiscal-profile')
  getFiscalProfile(@CurrentUser() user: AuthUser) {
    const clinicId = this.accessPolicy.assertClinicMember(user);
    return this.fiscalService.getFiscalProfile(clinicId);
  }

  @Put('fiscal-profile')
  @Roles('OWNER')
  updateFiscalProfile(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpsertFiscalProfileDto,
  ) {
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    return this.fiscalService.upsertFiscalProfile(clinicId, dto);
  }

  @Get('invoices/summary')
  getSummary(@CurrentUser() user: AuthUser) {
    const clinicId = this.accessPolicy.assertClinicMember(user);
    return this.fiscalService.getSummary(clinicId);
  }

  @Get('invoices')
  listInvoices(@CurrentUser() user: AuthUser, @Query() query: ListInvoicesDto) {
    const clinicId = this.accessPolicy.assertClinicMember(user);
    return this.fiscalService.listInvoices(clinicId, query);
  }

  @Get('invoices/:id')
  getInvoice(@CurrentUser() user: AuthUser, @Param('id') invoiceId: string) {
    const clinicId = this.accessPolicy.assertClinicMember(user);
    return this.fiscalService.getInvoice(clinicId, invoiceId);
  }

  @Post('invoices')
  createInvoice(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateServiceInvoiceDto,
  ) {
    const clinicId = this.accessPolicy.assertClinicMember(user);
    return this.fiscalService.createInvoice(clinicId, user, dto);
  }

  @Patch('invoices/:id')
  updateInvoice(
    @CurrentUser() user: AuthUser,
    @Param('id') invoiceId: string,
    @Body() dto: UpdateServiceInvoiceDto,
  ) {
    const clinicId = this.accessPolicy.assertClinicMember(user);
    return this.fiscalService.updateInvoice(clinicId, user, invoiceId, dto);
  }

  @Post('invoices/:id/mark-ready')
  @Roles('OWNER')
  markReady(@CurrentUser() user: AuthUser, @Param('id') invoiceId: string) {
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    return this.fiscalService.markReady(clinicId, user, invoiceId);
  }

  @Post('invoices/:id/simulate-issue')
  @Roles('OWNER')
  simulateIssue(@CurrentUser() user: AuthUser, @Param('id') invoiceId: string) {
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    return this.fiscalService.simulateIssue(clinicId, user, invoiceId);
  }

  @Post('invoices/:id/cancel')
  @Roles('OWNER')
  cancelInvoice(
    @CurrentUser() user: AuthUser,
    @Param('id') invoiceId: string,
    @Body() dto: CancelInvoiceDto,
  ) {
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    return this.fiscalService.cancelInvoice(clinicId, user, invoiceId, dto);
  }

  @Get('invoices/:id/pdf')
  getInvoicePdf(@CurrentUser() user: AuthUser, @Param('id') invoiceId: string) {
    const clinicId = this.accessPolicy.assertClinicMember(user);
    return this.fiscalService.getInvoicePdf(clinicId, invoiceId);
  }

  @Get('invoices/:id/xml')
  getInvoiceXml(@CurrentUser() user: AuthUser, @Param('id') invoiceId: string) {
    const clinicId = this.accessPolicy.assertClinicMember(user);
    return this.fiscalService.getInvoiceXml(clinicId, invoiceId);
  }
}
