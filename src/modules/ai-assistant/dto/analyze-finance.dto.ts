import { IsEnum, IsOptional, IsString, Matches } from 'class-validator';

export class AnalyzeFinanceDto {
  @IsString()
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from deve ser YYYY-MM-DD' })
  from?: string;

  @IsString()
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to deve ser YYYY-MM-DD' })
  to?: string;

  @IsEnum(['day', 'week', 'month'])
  @IsOptional()
  groupBy?: 'day' | 'week' | 'month';
}
