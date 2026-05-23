import { Transform } from 'class-transformer'
import { IsOptional, IsString, MaxLength, IsNotEmpty } from 'class-validator'

export class CreateStockCategoryDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string

  @IsOptional()
  @IsString()
  @MaxLength(32)
  color?: string
}
