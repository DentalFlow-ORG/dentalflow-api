import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class ListStripeEventsDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => parseInt(String(value), 10))
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => parseInt(String(value), 10))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  processed?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  type?: string;

  @IsOptional()
  @Matches(ISO_DATE, { message: 'from deve ser uma data no formato YYYY-MM-DD' })
  from?: string;

  @IsOptional()
  @Matches(ISO_DATE, { message: 'to deve ser uma data no formato YYYY-MM-DD' })
  to?: string;
}
