import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { IsSafeId, MAX_ID_LENGTH } from '../../../common/validators/input-validation.decorators';

export class FinanceIdParamDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
  id!: string;
}

export class AppointmentPaymentParamDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
  appointmentId!: string;
}
