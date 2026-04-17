import { Injectable } from '@nestjs/common';
import { authConfig } from '../../config/auth.config';
import { SignInDto } from './dto/sign-in.dto';

@Injectable()
export class AuthService {
  signIn(payload: SignInDto) {
    return {
      message: 'JWT authentication base prepared.',
      provider: 'jwt',
      email: payload.email,
      jwtConfigured: Boolean(authConfig.jwtSecret),
    };
  }
}
