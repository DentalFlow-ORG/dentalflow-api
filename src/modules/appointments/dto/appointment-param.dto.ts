import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { IsSafeId, MAX_ID_LENGTH } from '../../../common/validators/input-validation.decorators';

export class AppointmentIdParamDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
  id!: string;
}

export class ProfileParamDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
  profileId!: string;
}

export class AvailabilityParamDto extends ProfileParamDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
  availabilityId!: string;
}

export class AvailabilityExceptionParamDto extends ProfileParamDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
  exceptionId!: string;
}
