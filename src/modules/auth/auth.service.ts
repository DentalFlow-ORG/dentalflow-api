import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { authConfig } from '../../config/auth.config';
import { JwtPayload } from '../../common/types/jwt-payload.type';
import { AccessPolicyService } from '../../common/services/access-policy.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { SignInDto } from './dto/sign-in.dto';
import {
  AuthResponse,
  AuthResponseUser,
  LogoutResponse,
  RefreshResponse,
} from './types/auth-response.type';

export const PRIVACY_POLICY_VERSION = '2026-05-15';
export const TERMS_VERSION = '2026-05-15';

const BCRYPT_ROUNDS = 12;

export interface TokenMetadata {
  ipAddress?: string;
  deviceInfo?: string;
}

function generateRawToken(): string {
  return randomBytes(64).toString('hex');
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
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
        },
        select: {
          id: true,
          clinicId: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
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
            ? createHash('sha256').update(metadata.ipAddress).digest('hex').slice(0, 16)
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
        metadata: { privacyPolicyVersion: PRIVACY_POLICY_VERSION, termsVersion: TERMS_VERSION },
        ipAddress: metadata.ipAddress,
        userAgent: metadata.deviceInfo,
      }),
    ]);

    return {
      accessToken: this.sign(safeUser.id, safeUser.clinicId, safeUser.role, user.tokenVersion),
      refreshToken: rawRefreshToken,
      user: safeUser,
    };
  }

  async signIn(
    dto: SignInDto,
    metadata: TokenMetadata = {},
  ): Promise<AuthResponse> {
    const normalizedEmail = dto.email.trim().toLowerCase();

    const user = await this.prisma.user.findFirst({
      where: { email: normalizedEmail, isActive: true, deletedAt: null },
      select: {
        id: true,
        clinicId: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        tokenVersion: true,
        passwordHash: true,
      },
    });

    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      // Fire-and-forget: AuditLogService never throws; no reason to delay the 401 response
      void this.auditLog.log({
        action: 'USER_LOGIN_FAILURE',
        metadata: {
          emailHash: createHash('sha256').update(normalizedEmail).digest('hex').slice(0, 16),
          reason: 'INVALID_CREDENTIALS',
        },
        ipAddress: metadata.ipAddress,
        userAgent: metadata.deviceInfo,
      });
      throw new UnauthorizedException('E-mail ou senha inválidos');
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

    await this.auditLog.log({
      actorUserId: user.id,
      action: 'USER_LOGIN_SUCCESS',
      entityType: 'User',
      entityId: user.id,
      ipAddress: metadata.ipAddress,
      userAgent: metadata.deviceInfo,
    });

    return {
      accessToken: this.sign(safeUser.id, safeUser.clinicId, safeUser.role, user.tokenVersion),
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
      throw new UnauthorizedException('Sessão inválida');
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
      throw new UnauthorizedException('Sessão inválida');
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
      await tx.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date() },
      });

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

  async logout(userId: string, rawToken: string, metadata: TokenMetadata = {}): Promise<LogoutResponse> {
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
      },
    });

    if (!user) {
      throw new UnauthorizedException('Sessão inválida');
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
    };
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
