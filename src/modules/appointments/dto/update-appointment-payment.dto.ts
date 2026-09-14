import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  AppointmentPaymentMethod,
  AppointmentPaymentStatus,
} from '@prisma/client';
import {
  IsSafeId,
  MAX_CENTS_AMOUNT,
  MAX_ID_LENGTH,
} from '../../../common/validators/input-validation.decorators';

export class UpdateAppointmentPaymentDto {
  @IsEnum(AppointmentPaymentStatus, {
    message: 'Status de pagamento invalido.',
  })
  paymentStatus!: AppointmentPaymentStatus;

  @IsOptional()
  @IsInt({ message: 'Valor previsto deve ser um numero inteiro em centavos.' })
  @Min(0, { message: 'Valor previsto nao pode ser negativo.' })
  @Max(MAX_CENTS_AMOUNT)
  estimatedAmountCents?: number;

  @ValidateIf(
    (dto: UpdateAppointmentPaymentDto) =>
      dto.paymentStatus === AppointmentPaymentStatus.PAID ||
      dto.paymentStatus === AppointmentPaymentStatus.PARTIALLY_PAID,
  )
  @IsInt({ message: 'Valor pago deve ser um numero inteiro em centavos.' })
  @Min(1, { message: 'Valor pago deve ser maior que zero.' })
  @Max(MAX_CENTS_AMOUNT)
  paidAmountCents?: number;

  @IsOptional()
  @IsEnum(AppointmentPaymentMethod, {
    message: 'Forma de pagamento invalida.',
  })
  paymentMethod?: AppointmentPaymentMethod;

  @IsOptional()
  @IsISO8601({}, { message: 'Data de pagamento invalida.' })
  paymentDate?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(500, {
    message: 'Observacao financeira muito longa (max. 500 caracteres).',
  })
  paymentNotes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
  categoryId?: string;
}
