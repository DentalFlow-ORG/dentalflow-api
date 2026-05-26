import { IsBoolean, IsOptional } from 'class-validator';

export class StockCopilotDto {
  @IsOptional()
  @IsBoolean()
  forceRefresh?: boolean;
}
