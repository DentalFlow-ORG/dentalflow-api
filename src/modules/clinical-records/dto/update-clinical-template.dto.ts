import { ClinicalTemplateCategory } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

const TEMPLATE_CONTENT_MAX_LENGTH = 10_000;

export class UpdateClinicalTemplateDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsEnum(ClinicalTemplateCategory)
  category?: ClinicalTemplateCategory;

  @IsOptional()
  @IsString()
  @MaxLength(TEMPLATE_CONTENT_MAX_LENGTH)
  content?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
