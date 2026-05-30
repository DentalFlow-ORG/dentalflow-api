import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import {
  IsCalendarDate,
  IsSafeId,
  MAX_ID_LENGTH,
} from '../../../common/validators/input-validation.decorators';

export class ProcedureMarginsQueryDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'month deve estar no formato YYYY-MM.',
  })
  month?: string;

  @IsOptional()
  @IsString()
  @IsCalendarDate()
  startDate?: string;

  @IsOptional()
  @IsString()
  @IsCalendarDate()
  endDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
  profileId?: string;
}
