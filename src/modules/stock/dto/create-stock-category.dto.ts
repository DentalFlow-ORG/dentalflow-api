import { Transform } from 'class-transformer'
import { IsOptional, IsString, MaxLength, IsNotEmpty } from 'class-validator'
import { trimValue } from '../../../common/utils/transform.helpers'

export class CreateStockCategoryDto {
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string

  @IsOptional()
  @IsString()
  @MaxLength(32)
  color?: string
}
