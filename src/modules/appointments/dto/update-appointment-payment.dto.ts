import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  AppointmentPaymentMethod,
  AppointmentPaymentStatus,
} from '@prisma/client';

export class UpdateAppointmentPaymentDto {
  @IsEnum(AppointmentPaymentStatus, {
    message: 'Status de pagamento inválido.',
  })
  paymentStatus!: AppointmentPaymentStatus;

  @IsOptional()
  @IsInt({ message: 'Valor previsto deve ser um número inteiro em centavos.' })
  @Min(0, { message: 'Valor previsto não pode ser negativo.' })
  estimatedAmountCents?: number;

  // Required when PAID or PARTIALLY_PAID
  @ValidateIf(
    (dto: UpdateAppointmentPaymentDto) =>
      dto.paymentStatus === AppointmentPaymentStatus.PAID ||
      dto.paymentStatus === AppointmentPaymentStatus.PARTIALLY_PAID,
  )
  @IsInt({ message: 'Valor pago deve ser um número inteiro em centavos.' })
  @Min(1, { message: 'Valor pago deve ser maior que zero.' })
  paidAmountCents?: number;

  @IsOptional()
  @IsEnum(AppointmentPaymentMethod, {
    message: 'Forma de pagamento inválida.',
  })
  paymentMethod?: AppointmentPaymentMethod;

  @IsOptional()
  @IsISO8601({}, { message: 'Data de pagamento inválida.' })
  paymentDate?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(500, { message: 'Observação financeira muito longa (máx. 500 caracteres).' })
  paymentNotes?: string;

  @IsOptional()
  @IsString()
  categoryId?: string;
}
