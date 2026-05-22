import { Transform } from 'class-transformer';
import { IsEmail, MaxLength } from 'class-validator';
import { normalizeEmail } from '../../../common/utils/transform.helpers';

export class ForgotPasswordDto {
  @Transform(({ value }: { value: unknown }) => normalizeEmail(value))
  @IsEmail({}, { message: 'Informe um e-mail válido.' })
  @MaxLength(254)
  email!: string;
}
