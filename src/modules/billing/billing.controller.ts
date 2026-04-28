import { Controller, Get } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantScoped } from '../../common/decorators/tenant-scoped.decorator';
import { BillingService } from './billing.service';

@Controller('billing')
@TenantScoped()
@Roles('OWNER')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Get('template')
  getTemplate() {
    return this.billingService.getTemplate();
  }
}
