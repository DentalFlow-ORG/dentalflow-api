import { Module } from '@nestjs/common';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsService } from './appointments.service';
import { AvailabilityController } from './availability.controller';
import { CalendarIntegrationsModule } from '../calendar-integrations/calendar-integrations.module';

@Module({
  imports: [CalendarIntegrationsModule],
  controllers: [AppointmentsController, AvailabilityController],
  providers: [AppointmentsService],
})
export class AppointmentsModule {}
