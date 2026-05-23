import { Transform } from 'class-transformer'
import { IsOptional, IsString, MaxLength } from 'class-validator'

export class UpdateStockCategoryDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(80)
  name?: string

  @IsOptional()
  @IsString()
  @MaxLength(32)
  color?: string
}
