import { Module } from '@nestjs/common';
import { AuthModule } from './modules/auth/auth.module';
import { BillingModule } from './modules/billing/billing.module';
import { HealthModule } from './modules/health/health.module';
import { LeadsModule } from './modules/leads/leads.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { ProfilesModule } from './modules/profiles/profiles.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { UsersModule } from './modules/users/users.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    PrismaModule,
    HealthModule,
    AuthModule,
    UsersModule,
    ProfilesModule,
    LeadsModule,
    SubscriptionsModule,
    BillingModule,
    MetricsModule,
  ],
})
export class AppModule {}
