import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  IsSafeId,
  MAX_ID_LENGTH,
} from '../../../common/validators/input-validation.decorators';

export class ClassifyExpenseDto {
  @IsOptional()
  @IsBoolean()
  forceAi?: boolean;
}

export class ApplySuggestedCategoryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
  categoryId!: string;
}

export class BatchClassifyExpenseDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(MAX_ID_LENGTH, { each: true })
  @Type(() => String)
  transactionIds!: string[];

  @IsOptional()
  @IsBoolean()
  forceAi?: boolean;
}
