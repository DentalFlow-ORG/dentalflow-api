import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

// Avatar is stored as a compressed base64 JPEG data URL (≤512×512 px).
// The data-URL prefix is stripped before storage; only the raw base64 is kept.
// 200_000 chars ≈ 150 KB raw JPEG — generous for a 512×512 compressed avatar.
export const MAX_AVATAR_BASE64_LENGTH = 200_000;

export class UpsertPatientAvatarDto {
  /**
   * Stable clinical identity. Authoritative when present; `identifier` is the
   * compatibility fallback for clients that have not migrated yet.
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  patientId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(320)
  identifier!: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_AVATAR_BASE64_LENGTH)
  @Matches(/^[A-Za-z0-9+/=\s]+$/, {
    message: 'avatarBase64 deve conter apenas caracteres base64 válidos.',
  })
  avatarBase64?: string | null;
}
