import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { TenantGuard } from './common/guards/tenant.guard';
import { CommonModule } from './common/common.module';
import { AdminFinanceModule } from './modules/admin-finance/admin-finance.module';
import { ClinicalRecordsModule } from './modules/clinical-records/clinical-records.module';
import { AppointmentsModule } from './modules/appointments/appointments.module';
import { AuthModule } from './modules/auth/auth.module';
import { BillingModule } from './modules/billing/billing.module';
import { CalendarIntegrationsModule } from './modules/calendar-integrations/calendar-integrations.module';
import { FinanceModule } from './modules/finance/finance.module';
import { FiscalModule } from './modules/fiscal/fiscal.module';
import { HealthModule } from './modules/health/health.module';
import { PatientsModule } from './modules/patients/patients.module';
import { LeadsModule } from './modules/leads/leads.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { ProfilesModule } from './modules/profiles/profiles.module';
import { SpecialtiesModule } from './modules/specialties/specialties.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { UsersModule } from './modules/users/users.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000,
        limit: 120,
      },
    ]),
    PrismaModule,
    CommonModule,
    HealthModule,
    AuthModule,
    AdminFinanceModule,
    AppointmentsModule,
    UsersModule,
    ProfilesModule,
    SpecialtiesModule,
    LeadsModule,
    SubscriptionsModule,
    BillingModule,
    CalendarIntegrationsModule,
    FinanceModule,
    FiscalModule,
    PatientsModule,
    MetricsModule,
    ClinicalRecordsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
