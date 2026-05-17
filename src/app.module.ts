import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { BillingAccessGuard } from './common/guards/billing-access.guard';
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
import { StockModule } from './modules/stock/stock.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { UsersModule } from './modules/users/users.module';
import { AuditLogModule } from './modules/audit-log/audit-log.module';
import { PrivacyModule } from './modules/privacy/privacy.module';
import { AiAssistantModule } from './modules/ai-assistant/ai-assistant.module';
import { NotificationModule } from './modules/notification/notification.module';
import { ClinicModule } from './modules/clinic/clinic.module';
import { ReportsModule } from './modules/reports/reports.module';
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
    StockModule,
    LeadsModule,
    SubscriptionsModule,
    BillingModule,
    CalendarIntegrationsModule,
    FinanceModule,
    FiscalModule,
    PatientsModule,
    MetricsModule,
    ClinicalRecordsModule,
    AuditLogModule,
    PrivacyModule,
    AiAssistantModule,
    NotificationModule,
    ClinicModule,
    ReportsModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: BillingAccessGuard },
  ],
})
export class AppModule {}
