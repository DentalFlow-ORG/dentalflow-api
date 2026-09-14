/**
 * Applied to RegisterDto, UpdatePasswordDto, and ResetPasswordDto.
 * NOT applied to SignInDto — existing passwords must remain usable after the policy is introduced.
 */
export const PASSWORD_COMPLEXITY_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])(?=.*[^a-zA-Z0-9])/;

export const PASSWORD_COMPLEXITY_MESSAGE =
  'A senha deve conter pelo menos uma letra maiúscula, uma minúscula, um número e um caractere especial.';
