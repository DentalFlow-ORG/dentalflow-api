import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CookieOptions, Request, Response } from 'express';
import { appConfig } from '../../config/app.config';
import { authConfig } from '../../config/auth.config';
import { AnyAuthenticated } from '../../common/decorators/any-authenticated.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { AuthUser } from '../../common/types/auth-user.type';
import { isTrustedOrigin } from '../../common/utils/origin-allowlist';
import { AuthService, TokenMetadata } from './auth.service';
import { CompleteProfileDto } from './dto/complete-profile.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
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
  @Get('google')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async startGoogleAuth(@Res() res: Response) {
    try {
      const url = await this.authService.createGoogleAuthUrl();
      res.redirect(url);
    } catch {
      const fallbackUrl = new URL('/acessar', appConfig.frontendOrigin);
      fallbackUrl.searchParams.set('mode', 'login');
      fallbackUrl.searchParams.set('googleAuth', 'disabled');
      res.redirect(fallbackUrl.toString());
    }
  }

  @Public()
  @Get('google/callback')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async googleCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const fallbackUrl = new URL('/acessar', appConfig.frontendOrigin);
    fallbackUrl.searchParams.set('mode', 'login');

    if (error) {
      fallbackUrl.searchParams.set('googleAuth', 'cancelled');
      res.redirect(fallbackUrl.toString());
      return;
    }

    try {
      const result = await this.authService.handleGoogleCallback(
        code,
        state,
        this.extractMetadata(req),
      );
      this.setRefreshCookie(res, result.refreshToken);
      const redirectUrl = result.user.isProfileComplete
        ? appConfig.frontendAuthSuccessUrl
        : appConfig.frontendAuthCompleteProfileUrl;
      res.redirect(redirectUrl);
    } catch {
      fallbackUrl.searchParams.set('googleAuth', 'error');
      res.redirect(fallbackUrl.toString());
    }
  }

  @AnyAuthenticated()
  @Post('complete-profile')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async completeProfile(
    @CurrentUser() user: AuthUser,
    @Body() dto: CompleteProfileDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.completeProfile(
      user.id,
      dto,
      this.extractMetadata(req),
    );
    this.setRefreshCookie(res, result.refreshToken);
    return { accessToken: result.accessToken, user: result.user };
  }

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
    this.assertTrustedOrigin(req);
    const rawToken = this.extractRefreshCookie(req);
    if (!rawToken) {
      throw new UnauthorizedException('Sessão inválida');
    }
    const result = await this.authService.refresh(rawToken, this.extractMetadata(req));
    this.setRefreshCookie(res, result.refreshToken);
    return { accessToken: result.accessToken };
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    return this.authService.forgotPassword(dto, this.extractMetadata(req));
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    return this.authService.resetPassword(dto, this.extractMetadata(req));
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
    this.assertTrustedOrigin(req);
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

  /**
   * Rejects cookie-authenticated requests whose Origin is not allow-listed.
   *
   * The refresh cookie uses SameSite=None in production (the SPA and API are
   * cross-site), so SameSite no longer blocks cross-site CSRF on the
   * refresh/logout routes. Validating the Origin against the configured
   * frontend allowlist restores that protection. Requests without an Origin
   * header (non-browser callers) are allowed — they cannot be driven by a
   * browser CSRF and still need a valid cookie/JWT to do anything.
   */
  private assertTrustedOrigin(req: Request): void {
    const origin =
      typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!isTrustedOrigin(origin, appConfig.frontendOrigins)) {
      throw new ForbiddenException('Origem não permitida.');
    }
  }

  private refreshCookieOptions(): CookieOptions {
    const isProduction = appConfig.nodeEnv === 'production';
    return {
      httpOnly: true,
      secure: isProduction,
      // The SPA (Vercel) and API (Render) are cross-site in production, so the
      // refresh cookie must use SameSite=None to be sent on cross-site fetches;
      // None requires Secure, which prod (HTTPS) satisfies. Local dev runs both
      // on localhost (same-site) over HTTP, where Lax works without Secure.
      // CSRF on the cookie-authenticated routes is enforced by
      // assertTrustedOrigin() instead of relying on SameSite.
      sameSite: isProduction ? 'none' : 'lax',
      path: `/${appConfig.apiPrefix}/auth`,
    };
  }

  private setRefreshCookie(res: Response, token: string): void {
    res.cookie(REFRESH_COOKIE, token, {
      ...this.refreshCookieOptions(),
      maxAge: parseDurationMs(authConfig.jwtRefreshExpiresIn),
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, this.refreshCookieOptions());
  }
}
