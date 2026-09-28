import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  blankToNull,
  trimValue,
} from '../../../common/utils/transform.helpers';
import { IsOptionalButNotNull } from '../../../common/validators/input-validation.decorators';

export class UpdateStockCategoryDto {
  @IsOptionalButNotNull()
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @IsNotEmpty({ message: 'O nome da categoria é obrigatório.' })
  @MaxLength(80)
  name?: string;

  // `null` or a blank string clears the colour; absent leaves it unchanged.
  @Transform(({ value }: { value: unknown }) => blankToNull(value))
  @IsOptional()
  @IsString()
  @MaxLength(32)
  color?: string | null;
}
