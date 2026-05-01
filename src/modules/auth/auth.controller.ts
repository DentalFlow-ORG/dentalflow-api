import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { AnyAuthenticated } from '../../common/decorators/any-authenticated.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { AuthUser } from '../../common/types/auth-user.type';
import { AuthService, TokenMetadata } from './auth.service';
import { LogoutDto } from './dto/logout.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RegisterDto } from './dto/register.dto';
import { SignInDto } from './dto/sign-in.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('register')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.authService.register(dto, this.extractMetadata(req));
  }

  @Public()
  @Post(['sign-in', 'login'])
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  signIn(@Body() dto: SignInDto, @Req() req: Request) {
    return this.authService.signIn(dto, this.extractMetadata(req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.authService.refresh(
      dto.refreshToken,
      this.extractMetadata(req),
    );
  }

  @AnyAuthenticated()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  @AnyAuthenticated()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(@CurrentUser() user: AuthUser, @Body() dto: LogoutDto) {
    return this.authService.logout(user.id, dto.refreshToken);
  }

  private extractMetadata(req: Request): TokenMetadata {
    const rawUA = req.headers['user-agent'];
    return {
      ipAddress: req.ip,
      deviceInfo: typeof rawUA === 'string' ? rawUA : undefined,
    };
  }
}
