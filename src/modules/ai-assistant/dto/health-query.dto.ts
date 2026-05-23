import { IsBoolean, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';

export class HealthQueryDto {
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  live?: boolean;
}
