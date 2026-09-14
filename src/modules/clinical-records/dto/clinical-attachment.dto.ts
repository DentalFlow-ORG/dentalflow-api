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

const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const MAX_ATTACHMENT_SIZE_BYTES = 2 * 1024 * 1024;
const MAX_BASE64_FIELD_LENGTH = 120_000;

export class AddClinicalAttachmentDto {
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(180)
  // eslint-disable-next-line no-control-regex -- rejecting control bytes is the point
  @Matches(/^[^/\\\x00-\x1F\x7F]+$/, {
    message: 'Nome do arquivo nao pode conter caminhos ou caracteres de controle.',
  })
  fileName!: string;

  @IsOptional()
  @IsString()
  @IsIn(ALLOWED_IMAGE_MIME_TYPES)
  fileType?: string;

  @IsOptional()
  @IsString()
  @IsIn(ALLOWED_IMAGE_MIME_TYPES)
  mimeType?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_ATTACHMENT_SIZE_BYTES)
  sizeBytes?: number;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_BASE64_FIELD_LENGTH)
  @Matches(/^[A-Za-z0-9+/=:\-;,._\s]+$/, {
    message: 'Imagem deve ser enviada em formato base64 valido.',
  })
  dataBase64?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_BASE64_FIELD_LENGTH)
  @Matches(/^[A-Za-z0-9+/=:\-;,._\s]+$/, {
    message: 'Miniatura deve ser enviada em formato base64 valido.',
  })
  thumbnailBase64?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class UpdateClinicalAttachmentDescriptionDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @MaxLength(500)
  description?: string;
}
