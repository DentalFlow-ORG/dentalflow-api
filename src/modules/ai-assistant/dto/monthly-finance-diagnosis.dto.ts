import { IsBoolean, IsOptional, Matches } from 'class-validator';

export class MonthlyFinanceDiagnosisDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'month deve estar no formato YYYY-MM.',
  })
  month!: string;

  @IsOptional()
  @IsBoolean()
  forceRefresh?: boolean;
}
