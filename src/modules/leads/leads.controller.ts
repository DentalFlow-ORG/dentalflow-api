import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequiresBillingAccess } from '../../common/decorators/requires-billing-access.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantScoped } from '../../common/decorators/tenant-scoped.decorator';
import { AccessPolicyService } from '../../common/services/access-policy.service';
import { AuthUser } from '../../common/types/auth-user.type';
import { LeadsService } from './leads.service';
import { CreateLeadDto } from './dto/create-lead.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';
import { UpdateLeadStatusDto } from './dto/update-lead-status.dto';
import { CreateLeadActivityDto } from './dto/create-lead-activity.dto';
import { ListLeadsDto } from './dto/list-leads.dto';

@Controller('leads')
@TenantScoped()
@Roles('OWNER', 'ASSISTANT')
@RequiresBillingAccess()
export class LeadsController {
  constructor(
    private readonly leadsService: LeadsService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() dto: ListLeadsDto) {
    const clinicId = this.accessPolicy.assertOwnerOrAssistantAccess(user);
    return this.leadsService.listLeads(clinicId, dto);
  }

  @Get('summary')
  summary(@CurrentUser() user: AuthUser) {
    const clinicId = this.accessPolicy.assertOwnerOrAssistantAccess(user);
    return this.leadsService.getLeadSummary(clinicId);
  }

  @Get(':id')
  findById(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const clinicId = this.accessPolicy.assertOwnerOrAssistantAccess(user);
    return this.leadsService.findById(clinicId, id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateLeadDto) {
    const clinicId = this.accessPolicy.assertOwnerOrAssistantAccess(user);
    return this.leadsService.createLead(clinicId, user.id, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateLeadDto,
  ) {
    const clinicId = this.accessPolicy.assertOwnerOrAssistantAccess(user);
    return this.leadsService.updateLead(clinicId, user.id, id, dto);
  }

  @Patch(':id/status')
  updateStatus(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateLeadStatusDto,
  ) {
    const clinicId = this.accessPolicy.assertOwnerOrAssistantAccess(user);
    return this.leadsService.updateLeadStatus(clinicId, user.id, id, dto);
  }

  @Post(':id/activities')
  addActivity(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: CreateLeadActivityDto,
  ) {
    const clinicId = this.accessPolicy.assertOwnerOrAssistantAccess(user);
    return this.leadsService.addActivity(clinicId, user.id, id, dto);
  }

  @Get(':id/activities')
  listActivities(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const clinicId = this.accessPolicy.assertOwnerOrAssistantAccess(user);
    return this.leadsService.listActivities(clinicId, id);
  }

  @Post(':id/convert')
  @HttpCode(HttpStatus.OK)
  convert(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const clinicId = this.accessPolicy.assertOwnerOrAssistantAccess(user);
    return this.leadsService.convertLead(clinicId, user.id, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  archive(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const clinicId = this.accessPolicy.assertOwnerOrAssistantAccess(user);
    return this.leadsService.archiveLead(clinicId, user.id, id);
  }
}
