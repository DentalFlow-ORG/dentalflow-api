import { Transform } from 'class-transformer';
import {
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ListCookieConsentsDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  source?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  policyVersion?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsISO8601()
  dateFrom?: string;

  @IsOptional()
  @IsISO8601()
  dateTo?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value !== undefined ? Number(value) : undefined,
  )
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value !== undefined ? Number(value) : undefined,
  )
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
