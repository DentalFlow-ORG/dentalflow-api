import { Controller, Get } from '@nestjs/common';
import { RequiresBillingAccess } from '../../common/decorators/requires-billing-access.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantScoped } from '../../common/decorators/tenant-scoped.decorator';
import { MetricsService } from './metrics.service';

@Controller('metrics')
@TenantScoped()
@Roles('OWNER')
@RequiresBillingAccess()
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get('template')
  getTemplate() {
    return this.metricsService.getTemplate();
  }
}
