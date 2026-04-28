import { Module } from '@nestjs/common';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsService } from './appointments.service';
import { AvailabilityController } from './availability.controller';

@Module({
  controllers: [AppointmentsController, AvailabilityController],
  providers: [AppointmentsService],
})
export class AppointmentsModule {}
