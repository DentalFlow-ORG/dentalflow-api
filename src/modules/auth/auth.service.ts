import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { authConfig } from '../../config/auth.config';
import { googleAuthConfig } from '../../config/google-auth.config';
import { JwtPayload } from '../../common/types/jwt-payload.type';
import { AccessPolicyService } from '../../common/services/access-policy.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CompleteProfileDto } from './dto/complete-profile.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { SignInDto } from './dto/sign-in.dto';
import {
  AuthResponse,
  AuthResponseUser,
  LogoutResponse,
  MessageResponse,
  RefreshResponse,
} from './types/auth-response.type';
import {
  LoginIdentityRateLimitExceededException,
  LoginIdentityRateLimiterService,
} from './login-identity-rate-limiter.service';
import { MailService } from '../mail/mail.service';

export const PRIVACY_POLICY_VERSION = '2026-05-15';
export const TERMS_VERSION = '2026-05-15';

const BCRYPT_ROUNDS = 12;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const RESET_ERROR_MESSAGE = 'Solicitação inválida ou expirada.';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface TokenMetadata {
  ipAddress?: string;
  deviceInfo?: string;
}

type GoogleTokenResponse = {
  access_token?: string;
  error?: string;
  error_description?: string;
};

type GoogleUserInfo = {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  given_name?: string;
  family_name?: string;
  name?: string;
  picture?: string;
};

type AuthUserRecord = AuthResponseUser & {
  tokenVersion: number;
};

function generateRawToken(): string {
  return randomBytes(64).toString('hex');
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function hashIdentity(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function shortHash(hash: string): string {
  return hash.slice(0, 16);
}

function sanitizeUserAgent(value: string | undefined): string | undefined {
  return value ? value.slice(0, 512) : undefined;
}

function parseDurationMs(duration: string): number {
  const match = /^(\d+)([smhd])$/.exec(duration);
  if (!match) throw new Error(`Invalid duration string: "${duration}"`);
  const value = parseInt(match[1], 10);
  const units: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return value * units[match[2]];
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly accessPolicy: AccessPolicyService,
    private readonly auditLog: AuditLogService,
    private readonly loginIdentityRateLimiter: LoginIdentityRateLimiterService,
    private readonly mail: MailService,
  ) {}

  async register(
    dto: RegisterDto,
    metadata: TokenMetadata = {},
  ): Promise<AuthResponse> {
    const normalizedEmail = dto.email.trim().toLowerCase();
    const clinicName = dto.clinicName.trim();
    const firstName = dto.firstName.trim();
    const lastName = dto.lastName.trim();

    const existing = await this.prisma.user.findFirst({
      where: { email: normalizedEmail },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('Este e-mail já está em uso');
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const rawRefreshToken = generateRawToken();
    const refreshExpiresAt = new Date(
      Date.now() + parseDurationMs(authConfig.jwtRefreshExpiresIn),
    );

    const user = await this.prisma.$transaction(async (tx) => {
      const clinic = await tx.clinic.create({
        data: { name: clinicName },
      });

      const created = await tx.user.create({
        data: {
          clinicId: clinic.id,
          email: normalizedEmail,
          passwordHash,
          firstName,
          lastName,
          role: 'OWNER',
          isEmailVerified: false,
          isProfileComplete: true,
        },
        select: {
          id: true,
          clinicId: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          isProfileComplete: true,
          tokenVersion: true,
        },
      });

      await tx.refreshToken.create({
        data: {
          userId: created.id,
          tokenHash: hashToken(rawRefreshToken),
          expiresAt: refreshExpiresAt,
          ipAddress: metadata.ipAddress,
          deviceInfo: metadata.deviceInfo,
        },
      });

      await tx.termsAcceptance.create({
        data: {
          userId: created.id,
          privacyPolicyVersion: PRIVACY_POLICY_VERSION,
          termsVersion: TERMS_VERSION,
          ipHash: metadata.ipAddress
            ? createHash('sha256')
                .update(metadata.ipAddress)
                .digest('hex')
                .slice(0, 16)
            : null,
          userAgent: metadata.deviceInfo?.slice(0, 512) ?? null,
        },
      });

      return created;
    });

    const safeUser = this.toAuthResponseUser(user);

    await Promise.all([
      this.auditLog.log({
        actorUserId: user.id,
        action: 'USER_CREATED',
        entityType: 'User',
        entityId: user.id,
        metadata: { clinicId: user.clinicId },
        ipAddress: metadata.ipAddress,
        userAgent: metadata.deviceInfo,
      }),
      this.auditLog.log({
        actorUserId: user.id,
        action: 'TERMS_ACCEPTED',
        entityType: 'User',
        entityId: user.id,
        metadata: {
          privacyPolicyVersion: PRIVACY_POLICY_VERSION,
          termsVersion: TERMS_VERSION,
        },
        ipAddress: metadata.ipAddress,
        userAgent: metadata.deviceInfo,
      }),
    ]);

    return {
      accessToken: this.sign(
        safeUser.id,
        safeUser.clinicId,
        safeUser.role,
        user.tokenVersion,
      ),
      refreshToken: rawRefreshToken,
      user: safeUser,
    };
  }

  async signIn(
    dto: SignInDto,
    metadata: TokenMetadata = {},
  ): Promise<AuthResponse> {
    const normalizedEmail = dto.email.trim().toLowerCase();
    const emailHash = hashIdentity(normalizedEmail);

    try {
      this.loginIdentityRateLimiter.assertCanAttempt(emailHash);
    } catch (err) {
      if (err instanceof LoginIdentityRateLimitExceededException) {
        void this.logLoginFailure(emailHash, 'RATE_LIMITED', metadata);
      }
      throw err;
    }

    const user = await this.prisma.user.findFirst({
      where: { email: normalizedEmail, isActive: true, deletedAt: null },
      select: {
        id: true,
        clinicId: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        isProfileComplete: true,
        tokenVersion: true,
        passwordHash: true,
      },
    });

    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      this.loginIdentityRateLimiter.recordFailure(emailHash);
      void this.logLoginFailure(emailHash, 'INVALID_CREDENTIALS', metadata);
      throw new UnauthorizedException('E-mail ou senha invalidos');
    }

    // Patients are clinical records only — they have no platform access
    if (user.role === 'PATIENT') {
      this.loginIdentityRateLimiter.recordFailure(emailHash);
      void this.logLoginFailure(
        emailHash,
        'PATIENT_ROLE_NOT_ALLOWED',
        metadata,
      );
      throw new UnauthorizedException('E-mail ou senha invalidos');
    }

    this.accessPolicy.assertValidRoleTenantShape({
      id: user.id,
      clinicId: user.clinicId,
      role: user.role,
    });

    const rawRefreshToken = generateRawToken();
    const refreshExpiresAt = new Date(
      Date.now() + parseDurationMs(authConfig.jwtRefreshExpiresIn),
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      await tx.refreshToken.deleteMany({
        where: { userId: user.id, expiresAt: { lt: new Date() } },
      });

      await tx.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(rawRefreshToken),
          expiresAt: refreshExpiresAt,
          ipAddress: metadata.ipAddress,
          deviceInfo: metadata.deviceInfo,
        },
      });
    });

    const safeUser = this.toAuthResponseUser(user);
    this.loginIdentityRateLimiter.reset(emailHash);

    await this.auditLog.log({
      actorUserId: user.id,
      action: 'USER_LOGIN_SUCCESS',
      entityType: 'User',
      entityId: user.id,
      ipAddress: metadata.ipAddress,
      userAgent: metadata.deviceInfo,
    });

    return {
      accessToken: this.sign(
        safeUser.id,
        safeUser.clinicId,
        safeUser.role,
        user.tokenVersion,
      ),
      refreshToken: rawRefreshToken,
      user: safeUser,
    };
  }

  async refresh(
    rawToken: string,
    metadata: TokenMetadata = {},
  ): Promise<RefreshResponse> {
    const tokenHash = hashToken(rawToken);

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        revokedAt: true,
        user: {
          select: {
            id: true,
            clinicId: true,
            role: true,
            isActive: true,
            deletedAt: true,
            tokenVersion: true,
          },
        },
      },
    });

    if (!stored) {
      this.logger.warn('Invalid refresh token attempt — token not found');
      void this.auditLog.log({
        action: 'USER_REFRESH_TOKEN_FAILED',
        metadata: { reason: 'TOKEN_NOT_FOUND' },
        ipAddress: metadata.ipAddress,
        userAgent: metadata.deviceInfo,
      });
      throw new UnauthorizedException('Sessao invalida');
    }

    // Revoked token reuse → possible theft; revoke all active sessions for safety
    if (stored.revokedAt !== null) {
      this.logger.warn(
        `Refresh token reuse detected — all sessions revoked for userId: ${stored.userId}`,
      );
      await this.prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      void this.auditLog.log({
        actorUserId: stored.userId,
        action: 'USER_REFRESH_TOKEN_FAILED',
        entityType: 'User',
        entityId: stored.userId,
        metadata: { reason: 'TOKEN_REUSE_DETECTED' },
        ipAddress: metadata.ipAddress,
        userAgent: metadata.deviceInfo,
      });
      throw new UnauthorizedException('Sessao invalida');
    }

    if (stored.expiresAt < new Date()) {
      this.logger.log(
        `Expired refresh token presented — userId: ${stored.userId}`,
      );
      void this.auditLog.log({
        actorUserId: stored.userId,
        action: 'USER_REFRESH_TOKEN_FAILED',
        entityType: 'User',
        entityId: stored.userId,
        metadata: { reason: 'TOKEN_EXPIRED' },
        ipAddress: metadata.ipAddress,
        userAgent: metadata.deviceInfo,
      });
      throw new UnauthorizedException('Sessão expirada');
    }

    if (!stored.user.isActive || stored.user.deletedAt !== null) {
      this.logger.warn(
        `Refresh attempt by inactive/deleted user — all sessions revoked for userId: ${stored.userId}`,
      );
      await this.prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      void this.auditLog.log({
        actorUserId: stored.userId,
        action: 'USER_REFRESH_TOKEN_FAILED',
        entityType: 'User',
        entityId: stored.userId,
        metadata: { reason: 'USER_INACTIVE' },
        ipAddress: metadata.ipAddress,
        userAgent: metadata.deviceInfo,
      });
      throw new UnauthorizedException('Acesso negado');
    }

    this.accessPolicy.assertValidRoleTenantShape({
      id: stored.user.id,
      clinicId: stored.user.clinicId,
      role: stored.user.role,
    });

    // Rotate: revoke old, prune expired, issue new — atomically
    const newRawToken = generateRawToken();
    const expiresAt = new Date(
      Date.now() + parseDurationMs(authConfig.jwtRefreshExpiresIn),
    );

    await this.prisma.$transaction(async (tx) => {
      const revoked = await tx.refreshToken.updateMany({
        where: {
          id: stored.id,
          tokenHash,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { revokedAt: new Date() },
      });

      if (revoked.count !== 1) {
        throw new UnauthorizedException('Sessao invalida');
      }

      await tx.refreshToken.deleteMany({
        where: { userId: stored.userId, expiresAt: { lt: new Date() } },
      });

      await tx.refreshToken.create({
        data: {
          userId: stored.userId,
          tokenHash: hashToken(newRawToken),
          expiresAt,
          ipAddress: metadata.ipAddress,
          deviceInfo: metadata.deviceInfo,
        },
      });
    });

    await this.auditLog.log({
      actorUserId: stored.user.id,
      action: 'USER_REFRESH_TOKEN',
      entityType: 'User',
      entityId: stored.user.id,
      metadata: { reason: 'TOKEN_ROTATED' },
      ipAddress: metadata.ipAddress,
      userAgent: metadata.deviceInfo,
    });

    return {
      accessToken: this.sign(
        stored.user.id,
        stored.user.clinicId,
        stored.user.role,
        stored.user.tokenVersion,
      ),
      refreshToken: newRawToken,
    };
  }

  async logout(
    userId: string,
    rawToken: string,
    metadata: TokenMetadata = {},
  ): Promise<LogoutResponse> {
    const tokenHash = hashToken(rawToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.auditLog.log({
      actorUserId: userId,
      action: 'USER_LOGOUT',
      entityType: 'User',
      entityId: userId,
      ipAddress: metadata.ipAddress,
      userAgent: metadata.deviceInfo,
    });
    return { success: true };
  }

  async createGoogleAuthUrl(): Promise<string> {
    this.assertGoogleAuthEnabled();

    await this.prisma.authOAuthState.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });

    const state = randomBytes(32).toString('hex');
    await this.prisma.authOAuthState.create({
      data: {
        state,
        expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
      },
    });

    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set('client_id', googleAuthConfig.clientId);
    url.searchParams.set('redirect_uri', googleAuthConfig.callbackUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    url.searchParams.set('prompt', 'select_account');

    return url.toString();
  }

  async handleGoogleCallback(
    code: string | undefined,
    state: string | undefined,
    metadata: TokenMetadata = {},
  ): Promise<AuthResponse> {
    this.assertGoogleAuthEnabled();

    if (!code || !state) {
      throw new BadRequestException('Retorno do Google incompleto.');
    }

    const storedState = await this.prisma.authOAuthState.findUnique({
      where: { state },
      select: { id: true, expiresAt: true },
    });

    if (!storedState || storedState.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Sessão de login com Google expirada.');
    }

    await this.prisma.authOAuthState.delete({ where: { id: storedState.id } });

    const token = await this.exchangeGoogleCode(code);
    if (!token.access_token) {
      throw new BadRequestException(
        'Não foi possível autenticar com o Google.',
      );
    }

    const googleUser = await this.fetchGoogleUser(token.access_token);
    if (
      !googleUser.sub ||
      !googleUser.email ||
      googleUser.email_verified !== true
    ) {
      throw new UnauthorizedException(
        'Não foi possível validar seu e-mail no Google.',
      );
    }

    const normalizedEmail = googleUser.email.trim().toLowerCase();
    const existing = await this.prisma.user.findFirst({
      where: { email: normalizedEmail },
      select: {
        id: true,
        clinicId: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        isActive: true,
        deletedAt: true,
        tokenVersion: true,
        googleId: true,
        isProfileComplete: true,
      },
    });

    if (existing) {
      if (!existing.isActive || existing.deletedAt !== null) {
        throw new UnauthorizedException(
          'Não foi possível autenticar com o Google.',
        );
      }

      if (existing.role === 'PATIENT' && existing.isProfileComplete) {
        throw new UnauthorizedException(
          'Não foi possível autenticar com o Google.',
        );
      }

      if (existing.googleId && existing.googleId !== googleUser.sub) {
        throw new UnauthorizedException(
          'Não foi possível autenticar com o Google.',
        );
      }

      const user = await this.prisma.user.update({
        where: { id: existing.id },
        data: {
          googleId: existing.googleId ?? googleUser.sub,
          isEmailVerified: true,
          lastLoginAt: new Date(),
        },
        select: this.authUserSelect(),
      });

      this.accessPolicy.assertValidRoleTenantShape({
        id: user.id,
        clinicId: user.clinicId,
        role: user.role,
      });

      return this.issueAuthResponse(user, metadata, 'google');
    }

    const splitName = this.splitGoogleName(googleUser);
    const created = await this.prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash: await bcrypt.hash(
          randomBytes(32).toString('hex'),
          BCRYPT_ROUNDS,
        ),
        firstName: splitName.firstName,
        lastName: splitName.lastName,
        role: 'PATIENT',
        googleId: googleUser.sub,
        avatarUrl: googleUser.picture?.slice(0, 2048) ?? null,
        isEmailVerified: true,
        isProfileComplete: false,
        lastLoginAt: new Date(),
      },
      select: this.authUserSelect(),
    });

    await this.auditLog.log({
      actorUserId: created.id,
      action: 'USER_CREATED',
      entityType: 'User',
      entityId: created.id,
      metadata: { source: 'google_oauth', requiresProfileCompletion: true },
      ipAddress: metadata.ipAddress,
      userAgent: metadata.deviceInfo,
    });

    return this.issueAuthResponse(created, metadata, 'google');
  }

  async completeProfile(
    userId: string,
    dto: CompleteProfileDto,
    metadata: TokenMetadata = {},
  ): Promise<AuthResponse> {
    const user = await this.prisma.user.findFirst({
      where: {
        id: userId,
        isActive: true,
        deletedAt: null,
        isProfileComplete: false,
      },
      select: {
        id: true,
        googleId: true,
        clinicId: true,
        role: true,
      },
    });

    if (
      !user ||
      !user.googleId ||
      user.clinicId !== null ||
      user.role !== 'PATIENT'
    ) {
      throw new ForbiddenException('Não foi possível concluir este perfil.');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const clinic = await tx.clinic.create({
        data: { name: dto.clinicName.trim() },
      });

      const completed = await tx.user.update({
        where: { id: user.id },
        data: {
          clinicId: clinic.id,
          firstName: dto.firstName.trim(),
          lastName: dto.lastName.trim(),
          role: 'OWNER',
          isProfileComplete: true,
          tokenVersion: { increment: 1 },
        },
        select: this.authUserSelect(),
      });

      await tx.termsAcceptance.create({
        data: {
          userId: completed.id,
          privacyPolicyVersion: PRIVACY_POLICY_VERSION,
          termsVersion: TERMS_VERSION,
          ipHash: metadata.ipAddress
            ? createHash('sha256')
                .update(metadata.ipAddress)
                .digest('hex')
                .slice(0, 16)
            : null,
          userAgent: metadata.deviceInfo?.slice(0, 512) ?? null,
        },
      });

      await tx.refreshToken.updateMany({
        where: { userId: completed.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      return completed;
    });

    await Promise.all([
      this.auditLog.log({
        actorUserId: updated.id,
        action: 'USER_UPDATED',
        entityType: 'User',
        entityId: updated.id,
        metadata: {
          reason: 'GOOGLE_PROFILE_COMPLETED',
          clinicId: updated.clinicId,
        },
        ipAddress: metadata.ipAddress,
        userAgent: metadata.deviceInfo,
      }),
      this.auditLog.log({
        actorUserId: updated.id,
        action: 'TERMS_ACCEPTED',
        entityType: 'User',
        entityId: updated.id,
        metadata: {
          privacyPolicyVersion: PRIVACY_POLICY_VERSION,
          termsVersion: TERMS_VERSION,
        },
        ipAddress: metadata.ipAddress,
        userAgent: metadata.deviceInfo,
      }),
    ]);

    return this.issueAuthResponse(updated, metadata, 'complete-profile');
  }

  async forgotPassword(
    dto: ForgotPasswordDto,
    metadata: TokenMetadata = {},
  ): Promise<MessageResponse> {
    const GENERIC_RESPONSE = {
      message:
        'Se este e-mail estiver cadastrado, você receberá um link para redefinir sua senha.',
    };

    const normalizedEmail = dto.email.trim().toLowerCase();

    const user = await this.prisma.user.findFirst({
      where: { email: normalizedEmail, isActive: true, deletedAt: null },
      select: { id: true, email: true },
    });

    if (!user) {
      return GENERIC_RESPONSE;
    }

    // Invalidate any previous unused reset tokens for this user
    await this.prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });

    const rawToken = generateRawToken();
    const tokenHash = hashToken(rawToken);

    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      },
    });

    await this.mail.sendPasswordResetEmail(user.email, rawToken);

    void this.auditLog.log({
      actorUserId: user.id,
      action: 'USER_PASSWORD_RESET_REQUESTED',
      entityType: 'User',
      entityId: user.id,
      ipAddress: metadata.ipAddress,
      userAgent: metadata.deviceInfo,
    });

    return GENERIC_RESPONSE;
  }

  async resetPassword(
    dto: ResetPasswordDto,
    metadata: TokenMetadata = {},
  ): Promise<MessageResponse> {
    const tokenHash = hashToken(dto.token);

    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        usedAt: true,
        user: {
          select: { id: true, isActive: true, deletedAt: true },
        },
      },
    });

    if (
      !record ||
      record.usedAt !== null ||
      record.expiresAt < new Date() ||
      !record.user.isActive ||
      record.user.deletedAt !== null
    ) {
      throw new UnprocessableEntityException(RESET_ERROR_MESSAGE);
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);

    await this.prisma.$transaction(async (tx) => {
      await tx.passwordResetToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      });

      await tx.user.update({
        where: { id: record.userId },
        data: { passwordHash, tokenVersion: { increment: 1 } },
      });

      await tx.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    void this.auditLog.log({
      actorUserId: record.userId,
      action: 'USER_PASSWORD_CHANGED',
      entityType: 'User',
      entityId: record.userId,
      ipAddress: metadata.ipAddress,
      userAgent: metadata.deviceInfo,
    });

    return { message: 'Senha redefinida com sucesso.' };
  }

  async getCurrentUser(userId: string): Promise<AuthResponseUser> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isActive: true, deletedAt: null },
      select: {
        id: true,
        clinicId: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        isProfileComplete: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('Sessao invalida');
    }

    this.accessPolicy.assertValidRoleTenantShape({
      id: user.id,
      clinicId: user.clinicId,
      role: user.role,
    });

    return this.toAuthResponseUser(user);
  }

  private toAuthResponseUser(user: AuthResponseUser): AuthResponseUser {
    return {
      id: user.id,
      clinicId: user.clinicId,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      isProfileComplete: user.isProfileComplete,
    };
  }

  private async issueAuthResponse(
    user: AuthUserRecord,
    metadata: TokenMetadata,
    source: 'password' | 'google' | 'complete-profile',
  ): Promise<AuthResponse> {
    const rawRefreshToken = generateRawToken();
    const refreshExpiresAt = new Date(
      Date.now() + parseDurationMs(authConfig.jwtRefreshExpiresIn),
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.refreshToken.deleteMany({
        where: { userId: user.id, expiresAt: { lt: new Date() } },
      });

      await tx.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(rawRefreshToken),
          expiresAt: refreshExpiresAt,
          ipAddress: metadata.ipAddress,
          deviceInfo: metadata.deviceInfo,
        },
      });
    });

    await this.auditLog.log({
      actorUserId: user.id,
      action: 'USER_LOGIN_SUCCESS',
      entityType: 'User',
      entityId: user.id,
      metadata: { source },
      ipAddress: metadata.ipAddress,
      userAgent: metadata.deviceInfo,
    });

    const safeUser = this.toAuthResponseUser(user);

    return {
      accessToken: this.sign(
        safeUser.id,
        safeUser.clinicId,
        safeUser.role,
        user.tokenVersion,
      ),
      refreshToken: rawRefreshToken,
      user: safeUser,
    };
  }

  private authUserSelect() {
    return {
      id: true,
      clinicId: true,
      email: true,
      firstName: true,
      lastName: true,
      role: true,
      isProfileComplete: true,
      tokenVersion: true,
    } as const;
  }

  private assertGoogleAuthEnabled(): void {
    if (
      !googleAuthConfig.enabled ||
      !googleAuthConfig.clientId ||
      !googleAuthConfig.clientSecret ||
      !googleAuthConfig.callbackUrl
    ) {
      throw new InternalServerErrorException(
        'Login com Google indisponível no momento.',
      );
    }
  }

  private async exchangeGoogleCode(code: string): Promise<GoogleTokenResponse> {
    const body = new URLSearchParams({
      code,
      client_id: googleAuthConfig.clientId,
      client_secret: googleAuthConfig.clientSecret,
      redirect_uri: googleAuthConfig.callbackUrl,
      grant_type: 'authorization_code',
    });

    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const token = (await response.json()) as GoogleTokenResponse;

    if (!response.ok) {
      throw new BadRequestException(
        'Não foi possível autenticar com o Google.',
      );
    }

    return token;
  }

  private async fetchGoogleUser(accessToken: string): Promise<GoogleUserInfo> {
    const response = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new BadRequestException(
        'Não foi possível validar sua conta Google.',
      );
    }

    return response.json() as Promise<GoogleUserInfo>;
  }

  private splitGoogleName(googleUser: GoogleUserInfo): {
    firstName: string;
    lastName: string;
  } {
    const givenName = googleUser.given_name?.trim();
    const familyName = googleUser.family_name?.trim();
    if (givenName && familyName) {
      return {
        firstName: givenName.slice(0, 50),
        lastName: familyName.slice(0, 50),
      };
    }

    const parts = (googleUser.name ?? '').trim().split(/\s+/).filter(Boolean);

    if (parts.length >= 2) {
      return {
        firstName: parts[0].slice(0, 50),
        lastName: parts.slice(1).join(' ').slice(0, 50),
      };
    }

    return {
      firstName: (givenName || parts[0] || 'Usuário').slice(0, 50),
      lastName: familyName || '',
    };
  }

  private logLoginFailure(
    emailHash: string,
    reason: 'INVALID_CREDENTIALS' | 'PATIENT_ROLE_NOT_ALLOWED' | 'RATE_LIMITED',
    metadata: TokenMetadata,
  ): Promise<void> {
    return this.auditLog.log({
      action: 'USER_LOGIN_FAILURE',
      metadata: {
        emailHash: shortHash(emailHash),
        reason,
      },
      ipAddress: metadata.ipAddress,
      userAgent: sanitizeUserAgent(metadata.deviceInfo),
    });
  }

  private sign(
    userId: string,
    clinicId: string | null,
    role: UserRole,
    tokenVersion: number,
  ): string {
    const payload: JwtPayload = { sub: userId, clinicId, role, tokenVersion };
    return this.jwt.sign(payload);
  }
}
