import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  AppointmentStatus,
  FinancialTransactionStatus,
  FinancialTransactionType,
  ServiceInvoiceStatus,
} from '@prisma/client';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export class ReportDateRangeDto {
  @IsOptional()
  @IsString()
  @Matches(datePattern, {
    message: 'Data inicial deve estar no formato AAAA-MM-DD',
  })
  startDate?: string;

  @IsOptional()
  @IsString()
  @Matches(datePattern, {
    message: 'Data final deve estar no formato AAAA-MM-DD',
  })
  endDate?: string;
}

export class FinanceReportQueryDto extends ReportDateRangeDto {
  @IsOptional()
  @IsEnum(FinancialTransactionType, { message: 'Tipo de transação inválido' })
  type?: FinancialTransactionType;

  @IsOptional()
  @IsEnum(FinancialTransactionStatus, { message: 'Status financeiro inválido' })
  status?: FinancialTransactionStatus;

  @IsOptional()
  @IsString()
  categoryId?: string;
}

export class AppointmentsReportQueryDto extends ReportDateRangeDto {
  @IsOptional()
  @IsEnum(AppointmentStatus, { message: 'Status de agendamento inválido' })
  status?: AppointmentStatus;

  @IsOptional()
  @IsString()
  profileId?: string;
}

export class InventoryReportQueryDto {
  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsString()
  status?: string;
}

export class InvoicesReportQueryDto extends ReportDateRangeDto {
  @IsOptional()
  @IsEnum(ServiceInvoiceStatus, { message: 'Status de nota fiscal inválido' })
  status?: ServiceInvoiceStatus;
}
