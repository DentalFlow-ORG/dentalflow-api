import { ClinicalTemplateCategory } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

const TEMPLATE_CONTENT_MAX_LENGTH = 10_000;

export class CreateClinicalTemplateDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @IsEnum(ClinicalTemplateCategory)
  category!: ClinicalTemplateCategory;

  @IsString()
  @IsNotEmpty()
  @MaxLength(TEMPLATE_CONTENT_MAX_LENGTH)
  content!: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
