import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { trimValue } from '../../../common/utils/transform.helpers';

export const ALLOWED_AUDIO_MIME_TYPES = [
  'audio/webm',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
] as const;

// 6.5 MB of base64 ≈ 4.875 MB raw audio ≈ ~680 s at 48 kbps (far above the
// 90 s frontend cap).  Kept below the 8 MB route-parser limit so DTO validation
// returns a clean 400 instead of body-parser throwing a 413.
export const MAX_AUDIO_BASE64_LENGTH = 6_500_000;
export const MAX_DURATION_SECONDS = 120;

export class DictateRecordDto {
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_AUDIO_BASE64_LENGTH)
  @Matches(/^[A-Za-z0-9+/=\s]+$/, {
    message: 'audioBase64 deve conter apenas caracteres base64 válidos.',
  })
  audioBase64!: string;

  @IsString()
  @IsIn(ALLOWED_AUDIO_MIME_TYPES)
  mimeType!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_DURATION_SECONDS)
  durationSeconds?: number;
}
