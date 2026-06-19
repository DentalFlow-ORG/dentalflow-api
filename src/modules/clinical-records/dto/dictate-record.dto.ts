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
  // Explicit Opus codec variants — preferred by the frontend for small file size.
  // Must appear here so DTO validation accepts the mimeType the browser reports.
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  // Generic container fallbacks
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
] as const;

// 4 MB of base64 ≈ 3 MB raw audio ≈ ~133 kbps for 180 s — well above the
// 32 kbps target and the 180 s frontend cap. Kept below the 6 MB route-parser
// limit so DTO validation returns a clean 400 before body-parser throws 413.
export const MAX_AUDIO_BASE64_LENGTH = 4_000_000;
export const MAX_DURATION_SECONDS = 180;

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
