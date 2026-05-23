import { IsOptional, IsString } from 'class-validator';
import { IsCalendarDate } from '../../../common/validators/input-validation.decorators';

export class ListAppointmentsQueryDto {
  @IsOptional()
  @IsString()
  @IsCalendarDate()
  date?: string;
}
