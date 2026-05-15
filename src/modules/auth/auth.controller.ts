import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { appConfig } from '../../config/app.config';
import { authConfig } from '../../config/auth.config';
import { AnyAuthenticated } from '../../common/decorators/any-authenticated.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { AuthUser } from '../../common/types/auth-user.type';
import { AuthService, TokenMetadata } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { SignInDto } from './dto/sign-in.dto';

const REFRESH_COOKIE = 'refresh_token';

function parseDurationMs(duration: string): number {
  const match = /^(\d+)([smhd])$/.exec(duration);
  if (!match) return 7 * 86_400_000;
  const value = parseInt(match[1], 10);
  const units: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return value * units[match[2]];
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('register')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.register(dto, this.extractMetadata(req));
    this.setRefreshCookie(res, result.refreshToken);
    return { accessToken: result.accessToken, user: result.user };
  }

  @Public()
  @Post(['sign-in', 'login'])
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async signIn(
    @Body() dto: SignInDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.signIn(dto, this.extractMetadata(req));
    this.setRefreshCookie(res, result.refreshToken);
    return { accessToken: result.accessToken, user: result.user };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const rawToken = this.extractRefreshCookie(req);
    if (!rawToken) {
      throw new UnauthorizedException('Sessão inválida');
    }
    const result = await this.authService.refresh(rawToken, this.extractMetadata(req));
    this.setRefreshCookie(res, result.refreshToken);
    return { accessToken: result.accessToken };
  }

  @AnyAuthenticated()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.authService.getCurrentUser(user.id);
  }

  @AnyAuthenticated()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rawToken = this.extractRefreshCookie(req);
    this.clearRefreshCookie(res);
    if (!rawToken) {
      return { success: true };
    }
    return this.authService.logout(user.id, rawToken, this.extractMetadata(req));
  }

  private extractMetadata(req: Request): TokenMetadata {
    const rawUA = req.headers['user-agent'];
    return {
      ipAddress: req.ip,
      deviceInfo: typeof rawUA === 'string' ? rawUA : undefined,
    };
  }

  private extractRefreshCookie(req: Request): string | null {
    const cookieHeader = req.headers['cookie'];
    if (!cookieHeader) return null;
    const match = /(?:^|;\s*)refresh_token=([^;]+)/.exec(cookieHeader);
    return match ? decodeURIComponent(match[1]) : null;
  }

  private setRefreshCookie(res: Response, token: string): void {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: appConfig.nodeEnv === 'production',
      sameSite: 'strict',
      path: `/${appConfig.apiPrefix}/auth`,
      maxAge: parseDurationMs(authConfig.jwtRefreshExpiresIn),
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      secure: appConfig.nodeEnv === 'production',
      sameSite: 'strict',
      path: `/${appConfig.apiPrefix}/auth`,
    });
  }
}
