import { IsString, Matches } from 'class-validator';

export class SyncCheckoutSessionDto {
  @IsString()
  @Matches(/^cs_(test|live)_[A-Za-z0-9]+$/, {
    message: 'Sessão de checkout inválida.',
  })
  sessionId!: string;
}
