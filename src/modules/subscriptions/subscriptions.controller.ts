import { Controller, Get } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantScoped } from '../../common/decorators/tenant-scoped.decorator';
import { SubscriptionsService } from './subscriptions.service';

@Controller('subscriptions')
@TenantScoped()
@Roles('OWNER')
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  @Get('template')
  getTemplate() {
    return this.subscriptionsService.getTemplate();
  }
}
