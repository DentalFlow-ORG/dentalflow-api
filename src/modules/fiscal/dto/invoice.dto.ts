import { AppointmentPaymentStatus, ServiceInvoiceStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

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

  @IsString({ message: 'Nome do cliente é obrigatório.' })
  customerName!: string;

  @IsOptional()
  @IsString({ message: 'CPF/CNPJ do cliente deve ser um texto.' })
  customerDocument?: string;

  @IsOptional()
  @IsEmail({}, { message: 'E-mail do cliente inválido.' })
  customerEmail?: string;

  @IsOptional()
  @IsString({ message: 'Telefone do cliente deve ser um texto.' })
  customerPhone?: string;

  @IsString({ message: 'Descrição do serviço é obrigatória.' })
  serviceDescription!: string;

  @IsOptional()
  @IsString({ message: 'Código de serviço deve ser um texto.' })
  serviceCode?: string;

  @Type(() => Number)
  @IsInt({ message: 'Valor deve ser informado em centavos como número inteiro.' })
  @Min(1, { message: 'Valor da nota fiscal deve ser maior que zero.' })
  amountCents!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Deduções devem ser informadas em centavos como número inteiro.' })
  @Min(0, { message: 'Deduções não podem ser negativas.' })
  deductionsCents?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'Alíquota de ISS deve ser um número.' })
  @Min(0, { message: 'Alíquota de ISS não pode ser negativa.' })
  @Max(100, { message: 'Alíquota de ISS não pode ser maior que 100%.' })
  issRate?: number;

  @IsDateString({}, { message: 'Data de competência inválida.' })
  competenceDate!: string;

  @IsOptional()
  @IsString({ message: 'Observações devem ser um texto.' })
  notes?: string;
}

export class UpdateServiceInvoiceDto {
  @IsOptional()
  @IsString({ message: 'Paciente deve ser um identificador válido.' })
  patientId?: string;

  @IsOptional()
  @IsString({ message: 'Atendimento deve ser um identificador válido.' })
  appointmentId?: string;

  @IsOptional()
  @IsString({ message: 'Nome do cliente deve ser um texto.' })
  customerName?: string;

  @IsOptional()
  @IsString({ message: 'CPF/CNPJ do cliente deve ser um texto.' })
  customerDocument?: string;

  @IsOptional()
  @IsEmail({}, { message: 'E-mail do cliente inválido.' })
  customerEmail?: string;

  @IsOptional()
  @IsString({ message: 'Telefone do cliente deve ser um texto.' })
  customerPhone?: string;

  @IsOptional()
  @IsString({ message: 'Descrição do serviço deve ser um texto.' })
  serviceDescription?: string;

  @IsOptional()
  @IsString({ message: 'Código de serviço deve ser um texto.' })
  serviceCode?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Valor deve ser informado em centavos como número inteiro.' })
  @Min(1, { message: 'Valor da nota fiscal deve ser maior que zero.' })
  amountCents?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Deduções devem ser informadas em centavos como número inteiro.' })
  @Min(0, { message: 'Deduções não podem ser negativas.' })
  deductionsCents?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'Alíquota de ISS deve ser um número.' })
  @Min(0, { message: 'Alíquota de ISS não pode ser negativa.' })
  @Max(100, { message: 'Alíquota de ISS não pode ser maior que 100%.' })
  issRate?: number;

  @IsOptional()
  @IsDateString({}, { message: 'Data de competência inválida.' })
  competenceDate?: string;

  @IsOptional()
  @IsString({ message: 'Observações devem ser um texto.' })
  notes?: string;
}

export class CancelInvoiceDto {
  @IsString({ message: 'Motivo do cancelamento é obrigatório.' })
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
  @IsEnum(AppointmentPaymentStatus, { message: 'Status de pagamento inválido.' })
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
