import { normalizePhoneSnapshot } from '../../../common/utils/transform.helpers';
import { AppointmentPaymentStatus, ServiceInvoiceStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  blankToUndefined,
  trimValue,
} from '../../../common/utils/transform.helpers';
import {
  IsOptionalButNotNull,
  MAX_CENTS_AMOUNT,
} from '../../../common/validators/input-validation.decorators';

// Limits mirrored by the web invoice form. customerDocument is checked with
// its mask allowed: 11 (CPF) or 14 (CNPJ) digits; the service strips it.
const CUSTOMER_NAME_MAX = 150;
const CUSTOMER_EMAIL_MAX = 254;
const CUSTOMER_PHONE_MAX = 20;
const SERVICE_DESCRIPTION_MAX = 2000;
const SERVICE_CODE_MAX = 50;
const NOTES_MAX = 2000;
const CANCEL_REASON_MAX = 500;
const DOCUMENT_PATTERN = /^\D*(?:\d\D*){11}$|^\D*(?:\d\D*){14}$/;

export class ListInvoicesDto {
  @IsOptional()
  @IsEnum(ServiceInvoiceStatus, { message: 'Status da nota fiscal inválido.' })
  status?: ServiceInvoiceStatus;

  @IsOptional()
  @IsString({ message: 'Cliente deve ser um texto.' })
  customer?: string;

  @IsOptional()
  @IsDateString({}, { message: 'Data inicial inválida.' })
  from?: string;

  @IsOptional()
  @IsDateString({}, { message: 'Data final inválida.' })
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Página deve ser um número inteiro.' })
  @Min(1, { message: 'Página deve ser maior ou igual a 1.' })
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Limite deve ser um número inteiro.' })
  @Min(1, { message: 'Limite deve ser maior ou igual a 1.' })
  @Max(100, { message: 'Limite deve ser menor ou igual a 100.' })
  limit?: number;
}

export class CreateServiceInvoiceDto {
  @IsOptional()
  @IsString({ message: 'Paciente deve ser um identificador válido.' })
  patientId?: string;

  @IsOptional()
  @IsString({ message: 'Atendimento deve ser um identificador válido.' })
  appointmentId?: string;

  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString({ message: 'Nome do cliente é obrigatório.' })
  @IsNotEmpty({ message: 'Nome do cliente é obrigatório.' })
  @MaxLength(CUSTOMER_NAME_MAX, {
    message: 'Nome do cliente deve ter no máximo 150 caracteres.',
  })
  customerName!: string;

  @Transform(({ value }: { value: unknown }) => blankToUndefined(value))
  @IsOptional()
  @IsString({ message: 'CPF/CNPJ do cliente deve ser um texto.' })
  @Matches(DOCUMENT_PATTERN, {
    message: 'CPF/CNPJ do cliente deve ter 11 ou 14 dígitos.',
  })
  customerDocument?: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? blankToUndefined(value.toLowerCase()) : value,
  )
  @IsOptional()
  @IsEmail({}, { message: 'E-mail do cliente inválido.' })
  @MaxLength(CUSTOMER_EMAIL_MAX, {
    message: 'E-mail do cliente deve ter no máximo 254 caracteres.',
  })
  customerEmail?: string;

  @Transform(({ value }: { value: unknown }) =>
    blankToUndefined(normalizePhoneSnapshot(value)),
  )
  @IsOptional()
  @IsString({ message: 'Telefone do cliente deve ser um texto.' })
  @MaxLength(CUSTOMER_PHONE_MAX, {
    message: 'Telefone do cliente deve ter no máximo 20 caracteres.',
  })
  customerPhone?: string;

  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString({ message: 'Descrição do serviço é obrigatória.' })
  @IsNotEmpty({ message: 'Descrição do serviço é obrigatória.' })
  @MaxLength(SERVICE_DESCRIPTION_MAX, {
    message: 'Descrição do serviço deve ter no máximo 2000 caracteres.',
  })
  serviceDescription!: string;

  @Transform(({ value }: { value: unknown }) => blankToUndefined(value))
  @IsOptional()
  @IsString({ message: 'Código de serviço deve ser um texto.' })
  @MaxLength(SERVICE_CODE_MAX, {
    message: 'Código de serviço deve ter no máximo 50 caracteres.',
  })
  serviceCode?: string;

  @Type(() => Number)
  @IsInt({
    message: 'Valor deve ser informado em centavos como número inteiro.',
  })
  @Min(1, { message: 'Valor da nota fiscal deve ser maior que zero.' })
  @Max(MAX_CENTS_AMOUNT, {
    message: 'Valor da nota fiscal deve ser no máximo R$ 9.999.999,99.',
  })
  amountCents!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({
    message: 'Deduções devem ser informadas em centavos como número inteiro.',
  })
  @Min(0, { message: 'Deduções não podem ser negativas.' })
  @Max(MAX_CENTS_AMOUNT, {
    message: 'Deduções devem ser no máximo R$ 9.999.999,99.',
  })
  deductionsCents?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'Alíquota de ISS deve ser um número.' })
  @Min(0, { message: 'Alíquota de ISS não pode ser negativa.' })
  @Max(100, { message: 'Alíquota de ISS não pode ser maior que 100%.' })
  issRate?: number;

  @IsDateString({}, { message: 'Data de competência inválida.' })
  competenceDate!: string;

  @Transform(({ value }: { value: unknown }) => blankToUndefined(value))
  @IsOptional()
  @IsString({ message: 'Observações devem ser um texto.' })
  @MaxLength(NOTES_MAX, {
    message: 'Observações devem ter no máximo 2000 caracteres.',
  })
  notes?: string;
}

/**
 * PATCH contract: an absent or blank field is left unchanged; an explicit
 * `null` clears customerDocument, customerEmail, customerPhone, serviceCode
 * and notes. Required fields refuse `null`.
 */
export class UpdateServiceInvoiceDto {
  @IsOptional()
  @IsString({ message: 'Paciente deve ser um identificador válido.' })
  patientId?: string;

  @IsOptional()
  @IsString({ message: 'Atendimento deve ser um identificador válido.' })
  appointmentId?: string;

  @IsOptionalButNotNull()
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString({ message: 'Nome do cliente deve ser um texto.' })
  @IsNotEmpty({ message: 'Nome do cliente é obrigatório.' })
  @MaxLength(CUSTOMER_NAME_MAX, {
    message: 'Nome do cliente deve ter no máximo 150 caracteres.',
  })
  customerName?: string;

  @Transform(({ value }: { value: unknown }) => blankToUndefined(value))
  @IsOptional()
  @IsString({ message: 'CPF/CNPJ do cliente deve ser um texto.' })
  @Matches(DOCUMENT_PATTERN, {
    message: 'CPF/CNPJ do cliente deve ter 11 ou 14 dígitos.',
  })
  customerDocument?: string | null;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? blankToUndefined(value.toLowerCase()) : value,
  )
  @IsOptional()
  @IsEmail({}, { message: 'E-mail do cliente inválido.' })
  @MaxLength(CUSTOMER_EMAIL_MAX, {
    message: 'E-mail do cliente deve ter no máximo 254 caracteres.',
  })
  customerEmail?: string | null;

  @Transform(({ value }: { value: unknown }) =>
    blankToUndefined(normalizePhoneSnapshot(value)),
  )
  @IsOptional()
  @IsString({ message: 'Telefone do cliente deve ser um texto.' })
  @MaxLength(CUSTOMER_PHONE_MAX, {
    message: 'Telefone do cliente deve ter no máximo 20 caracteres.',
  })
  customerPhone?: string | null;

  @IsOptionalButNotNull()
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString({ message: 'Descrição do serviço deve ser um texto.' })
  @IsNotEmpty({ message: 'Descrição do serviço é obrigatória.' })
  @MaxLength(SERVICE_DESCRIPTION_MAX, {
    message: 'Descrição do serviço deve ter no máximo 2000 caracteres.',
  })
  serviceDescription?: string;

  @Transform(({ value }: { value: unknown }) => blankToUndefined(value))
  @IsOptional()
  @IsString({ message: 'Código de serviço deve ser um texto.' })
  @MaxLength(SERVICE_CODE_MAX, {
    message: 'Código de serviço deve ter no máximo 50 caracteres.',
  })
  serviceCode?: string | null;

  @IsOptionalButNotNull()
  @Type(() => Number)
  @IsInt({
    message: 'Valor deve ser informado em centavos como número inteiro.',
  })
  @Min(1, { message: 'Valor da nota fiscal deve ser maior que zero.' })
  @Max(MAX_CENTS_AMOUNT, {
    message: 'Valor da nota fiscal deve ser no máximo R$ 9.999.999,99.',
  })
  amountCents?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({
    message: 'Deduções devem ser informadas em centavos como número inteiro.',
  })
  @Min(0, { message: 'Deduções não podem ser negativas.' })
  @Max(MAX_CENTS_AMOUNT, {
    message: 'Deduções devem ser no máximo R$ 9.999.999,99.',
  })
  deductionsCents?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'Alíquota de ISS deve ser um número.' })
  @Min(0, { message: 'Alíquota de ISS não pode ser negativa.' })
  @Max(100, { message: 'Alíquota de ISS não pode ser maior que 100%.' })
  issRate?: number;

  @IsOptionalButNotNull()
  @IsDateString({}, { message: 'Data de competência inválida.' })
  competenceDate?: string;

  @Transform(({ value }: { value: unknown }) => blankToUndefined(value))
  @IsOptional()
  @IsString({ message: 'Observações devem ser um texto.' })
  @MaxLength(NOTES_MAX, {
    message: 'Observações devem ter no máximo 2000 caracteres.',
  })
  notes?: string | null;
}

export class CancelInvoiceDto {
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString({ message: 'Motivo do cancelamento é obrigatório.' })
  @IsNotEmpty({ message: 'Motivo do cancelamento é obrigatório.' })
  @MaxLength(CANCEL_REASON_MAX, {
    message: 'Motivo do cancelamento deve ter no máximo 500 caracteres.',
  })
  reason!: string;
}

export class ListAppointmentsForInvoiceDto {
  @IsOptional()
  @IsString()
  patient?: string;

  @IsOptional()
  @IsDateString({}, { message: 'Data inicial inválida.' })
  from?: string;

  @IsOptional()
  @IsDateString({}, { message: 'Data final inválida.' })
  to?: string;

  @IsOptional()
  @IsString()
  profileId?: string;

  @IsOptional()
  @IsEnum(AppointmentPaymentStatus, {
    message: 'Status de pagamento inválido.',
  })
  paymentStatus?: AppointmentPaymentStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
