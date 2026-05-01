import { Module } from '@nestjs/common';
import { CalendarIntegrationsController } from './calendar-integrations.controller';
import { CalendarIntegrationsService } from './calendar-integrations.service';

@Module({
  controllers: [CalendarIntegrationsController],
  providers: [CalendarIntegrationsService],
})
export class CalendarIntegrationsModule {}
