import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsString,
  MaxLength,
} from 'class-validator';

export const BATCH_AVATARS_MAX_COUNT = 100;

export class BatchPatientAvatarsDto {
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value)
      ? (value as unknown[]).map((v) => (typeof v === 'string' ? v.trim() : v))
      : value,
  )
  @IsArray()
  @ArrayMinSize(1, { message: 'Pelo menos um identificador é necessário.' })
  @ArrayMaxSize(BATCH_AVATARS_MAX_COUNT, {
    message: `Máximo de ${BATCH_AVATARS_MAX_COUNT} identificadores por requisição.`,
  })
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(320, { each: true })
  identifiers!: string[];
}
