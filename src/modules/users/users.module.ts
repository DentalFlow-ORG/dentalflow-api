import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { AdminUsersController } from './admin-users.controller';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [BillingModule],
  controllers: [UsersController, AdminUsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
