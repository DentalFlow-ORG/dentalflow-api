import { Controller, Get } from '@nestjs/common';
import { RequiresBillingAccess } from '../../common/decorators/requires-billing-access.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantScoped } from '../../common/decorators/tenant-scoped.decorator';
import { LeadsService } from './leads.service';

@Controller('leads')
@TenantScoped()
@Roles('OWNER', 'DENTIST', 'ASSISTANT')
@RequiresBillingAccess()
export class LeadsController {
  constructor(private readonly leadsService: LeadsService) {}

  @Get('template')
  getTemplate() {
    return this.leadsService.getTemplate();
  }
}
