import { Prisma } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateBy,
} from 'class-validator';
import { trimValue } from '../../../common/utils/transform.helpers';

const MAX_ODONTOGRAM_JSON_DEPTH = 8;

function getJsonDepth(value: unknown, depth = 0): number {
  if (value === null || typeof value !== 'object') {
    return depth;
  }

  if (depth > MAX_ODONTOGRAM_JSON_DEPTH) {
    return depth;
  }

  const values = Array.isArray(value)
    ? value
    : Object.values(value as Record<string, unknown>);

  if (values.length === 0) {
    return depth + 1;
  }

  return Math.max(...values.map((item) => getJsonDepth(item, depth + 1)));
}

function IsJsonDepthWithinLimit() {
  return ValidateBy({
    name: 'isJsonDepthWithinLimit',
    validator: {
      validate(value: unknown) {
        return getJsonDepth(value) <= MAX_ODONTOGRAM_JSON_DEPTH;
      },
      defaultMessage() {
        return 'Dados do odontograma excedem a profundidade permitida.';
      },
    },
  });
}

function IsPlainJsonObject() {
  return ValidateBy({
    name: 'isPlainJsonObject',
    validator: {
      validate(value: unknown) {
        return (
          value !== null && typeof value === 'object' && !Array.isArray(value)
        );
      },
      defaultMessage() {
        return 'Dados do odontograma devem ser um objeto JSON.';
      },
    },
  });
}

export class UpsertOdontogramDto {
  /**
   * Stable clinical identity. When present it is authoritative and
   * `identifier` is ignored. `identifier` remains only so an older frontend
   * keeps working during the migration; it resolves through the legacy
   * contact-matching path, which refuses ambiguous matches.
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  patientId?: string;

  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(254)
  identifier!: string;

  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  patientName!: string;

  @IsPlainJsonObject()
  @IsJsonDepthWithinLimit()
  data!: Prisma.InputJsonObject;
}
