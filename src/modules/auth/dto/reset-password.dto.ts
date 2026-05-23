import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import {
  PASSWORD_COMPLEXITY_MESSAGE,
  PASSWORD_COMPLEXITY_REGEX,
} from '../../../common/validators/password-policy';

export class ResetPasswordDto {
  @IsString()
  @MaxLength(512)
  token!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  @Matches(PASSWORD_COMPLEXITY_REGEX, { message: PASSWORD_COMPLEXITY_MESSAGE })
  newPassword!: string;
}
