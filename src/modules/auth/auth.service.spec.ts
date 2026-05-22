// auth.config throws at import time when JWT_SECRET is absent — mock it before any imports
jest.mock('../../config/auth.config', () => ({
  authConfig: {
    jwtSecret: 'test-secret-key',
    jwtExpiresIn: '15m',
    jwtRefreshExpiresIn: '7d',
  },
}));

jest.mock('../../config/google-auth.config', () => ({
  googleAuthConfig: {
    enabled: false,
    clientId: '',
    clientSecret: '',
    callbackUrl: 'http://localhost:3000/api/auth/google/callback',
  },
}));

jest.mock('bcrypt');

import { ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';

import { AuthService } from './auth.service';
import { LoginIdentityRateLimitExceededException } from './login-identity-rate-limiter.service';

// ── Shared mock objects ───────────────────────────────────────────────────────

const txMock = {
  clinic: { create: jest.fn() },
  user: { create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  refreshToken: { create: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn() },
  termsAcceptance: { create: jest.fn() },
};

const prismaMock = {
  user: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  clinic: { create: jest.fn() },
  refreshToken: {
    create: jest.fn(),
    findUnique: jest.fn(),
    updateMany: jest.fn(),
    deleteMany: jest.fn(),
  },
  termsAcceptance: { create: jest.fn() },
  authOAuthState: {
    create: jest.fn(),
    findUnique: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  },
  $transaction: jest.fn(),
};

const jwtMock = { sign: jest.fn() };

const accessPolicyMock = { assertValidRoleTenantShape: jest.fn() };

const auditLogMock = { log: jest.fn() };

const rateLimiterMock = {
  assertCanAttempt: jest.fn(),
  recordFailure: jest.fn(),
  reset: jest.fn(),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildService(): AuthService {
  return new AuthService(
    prismaMock as never,
    jwtMock as never,
    accessPolicyMock as never,
    auditLogMock as never,
    rateLimiterMock as never,
  );
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(() => {
    jest.clearAllMocks();

    // Default implementations reset each test
    jwtMock.sign.mockReturnValue('signed-access-token');
    auditLogMock.log.mockResolvedValue(undefined);
    accessPolicyMock.assertValidRoleTenantShape.mockReturnValue(undefined);

    // $transaction calls the callback with txMock (works for both 1-tx and 2-tx paths)
    prismaMock.$transaction.mockImplementation(
      (cb: (tx: typeof txMock) => Promise<unknown>) => cb(txMock),
    );

    service = buildService();
  });

  // ── register ────────────────────────────────────────────────────────────────

  describe('register', () => {
    const dto = {
      email: 'owner@clinic.com',
      clinicName: 'My Clinic',
      firstName: 'João',
      lastName: 'Silva',
      password: 'Str0ng!Pass',
      acceptedTerms: true as const,
    };

    const dbUser = {
      id: 'user-1',
      clinicId: 'clinic-1',
      email: 'owner@clinic.com',
      firstName: 'João',
      lastName: 'Silva',
      role: 'OWNER' as const,
      isProfileComplete: true,
      tokenVersion: 0,
    };

    beforeEach(() => {
      prismaMock.user.findFirst.mockResolvedValue(null);
      (bcrypt.hash as jest.Mock).mockResolvedValue('hashed-password');
      txMock.clinic.create.mockResolvedValue({ id: 'clinic-1' });
      txMock.user.create.mockResolvedValue(dbUser);
      txMock.refreshToken.create.mockResolvedValue(undefined);
      txMock.termsAcceptance.create.mockResolvedValue(undefined);
    });

    it('returns accessToken, refreshToken, and user shape on success', async () => {
      const result = await service.register(dto);

      expect(result).toMatchObject({
        accessToken: 'signed-access-token',
        refreshToken: expect.any(String),
        user: {
          id: 'user-1',
          email: 'owner@clinic.com',
          role: 'OWNER',
          isProfileComplete: true,
        },
      });
    });

    it('creates a clinic and user inside a transaction', async () => {
      await service.register(dto);

      expect(txMock.clinic.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: { name: 'My Clinic' } }),
      );
      expect(txMock.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ email: 'owner@clinic.com', role: 'OWNER' }),
        }),
      );
    });

    it('creates a termsAcceptance record inside the transaction', async () => {
      await service.register(dto, { ipAddress: '1.2.3.4' });

      expect(txMock.termsAcceptance.create).toHaveBeenCalledTimes(1);
    });

    it('normalizes email to lowercase', async () => {
      await service.register({ ...dto, email: 'OWNER@CLINIC.COM' });

      expect(txMock.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ email: 'owner@clinic.com' }),
        }),
      );
    });

    it('throws ConflictException when the email is already in use', async () => {
      prismaMock.user.findFirst.mockResolvedValue({ id: 'existing-user' });

      await expect(service.register(dto)).rejects.toThrow(ConflictException);
    });

    it('logs USER_CREATED and TERMS_ACCEPTED audit events', async () => {
      await service.register(dto);

      const actions = (auditLogMock.log.mock.calls as [{ action: string }][]).map(
        ([input]) => input.action,
      );
      expect(actions).toContain('USER_CREATED');
      expect(actions).toContain('TERMS_ACCEPTED');
    });
  });

  // ── signIn ──────────────────────────────────────────────────────────────────

  describe('signIn', () => {
    const dto = { email: 'owner@clinic.com', password: 'correct-password' };

    const dbUser = {
      id: 'user-1',
      clinicId: 'clinic-1',
      email: 'owner@clinic.com',
      firstName: 'João',
      lastName: 'Silva',
      role: 'OWNER' as const,
      isProfileComplete: true,
      tokenVersion: 0,
      passwordHash: 'hashed-password',
    };

    beforeEach(() => {
      prismaMock.user.findFirst.mockResolvedValue(dbUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      txMock.user.update.mockResolvedValue(undefined);
      txMock.refreshToken.deleteMany.mockResolvedValue({ count: 0 });
      txMock.refreshToken.create.mockResolvedValue(undefined);
    });

    it('returns accessToken, refreshToken, and user shape on success', async () => {
      const result = await service.signIn(dto);

      expect(result).toMatchObject({
        accessToken: 'signed-access-token',
        refreshToken: expect.any(String),
        user: expect.objectContaining({ id: 'user-1', role: 'OWNER' }),
      });
    });

    it('resets the rate limiter on success', async () => {
      await service.signIn(dto);

      expect(rateLimiterMock.reset).toHaveBeenCalledTimes(1);
    });

    it('logs a USER_LOGIN_SUCCESS audit event', async () => {
      await service.signIn(dto);

      expect(auditLogMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'USER_LOGIN_SUCCESS' }),
      );
    });

    it('normalizes email to lowercase before lookup', async () => {
      await service.signIn({ ...dto, email: 'OWNER@CLINIC.COM' });

      expect(prismaMock.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ email: 'owner@clinic.com' }),
        }),
      );
    });

    it('throws UnauthorizedException when the user is not found', async () => {
      prismaMock.user.findFirst.mockResolvedValue(null);

      await expect(service.signIn(dto)).rejects.toThrow(UnauthorizedException);
    });

    it('records a failure when the user is not found', async () => {
      prismaMock.user.findFirst.mockResolvedValue(null);
      await expect(service.signIn(dto)).rejects.toThrow();

      expect(rateLimiterMock.recordFailure).toHaveBeenCalledTimes(1);
    });

    it('throws UnauthorizedException when the password does not match', async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(service.signIn(dto)).rejects.toThrow(UnauthorizedException);
    });

    it('records a failure when the password does not match', async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      await expect(service.signIn(dto)).rejects.toThrow();

      expect(rateLimiterMock.recordFailure).toHaveBeenCalledTimes(1);
    });

    it('throws UnauthorizedException and records a failure for PATIENT role', async () => {
      prismaMock.user.findFirst.mockResolvedValue({
        ...dbUser,
        role: 'PATIENT',
        clinicId: null,
      });

      await expect(service.signIn(dto)).rejects.toThrow(UnauthorizedException);
      expect(rateLimiterMock.recordFailure).toHaveBeenCalledTimes(1);
    });

    it('re-throws LoginIdentityRateLimitExceededException when already locked out', async () => {
      rateLimiterMock.assertCanAttempt.mockImplementation(() => {
        throw new LoginIdentityRateLimitExceededException();
      });

      await expect(service.signIn(dto)).rejects.toThrow(
        LoginIdentityRateLimitExceededException,
      );
    });
  });

  // ── refresh ─────────────────────────────────────────────────────────────────

  describe('refresh', () => {
    const rawToken = 'valid-raw-refresh-token';
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const storedToken = {
      id: 'rt-1',
      userId: 'user-1',
      expiresAt: futureDate,
      revokedAt: null,
      user: {
        id: 'user-1',
        clinicId: 'clinic-1',
        role: 'OWNER' as const,
        isActive: true,
        deletedAt: null,
        tokenVersion: 0,
      },
    };

    beforeEach(() => {
      prismaMock.refreshToken.findUnique.mockResolvedValue(storedToken);
      txMock.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      txMock.refreshToken.deleteMany.mockResolvedValue({ count: 0 });
      txMock.refreshToken.create.mockResolvedValue(undefined);
    });

    it('returns new accessToken and refreshToken on success', async () => {
      const result = await service.refresh(rawToken);

      expect(result).toMatchObject({
        accessToken: 'signed-access-token',
        refreshToken: expect.any(String),
      });
    });

    it('logs a USER_REFRESH_TOKEN audit event', async () => {
      await service.refresh(rawToken);

      expect(auditLogMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'USER_REFRESH_TOKEN' }),
      );
    });

    it('throws UnauthorizedException when the token is not found', async () => {
      prismaMock.refreshToken.findUnique.mockResolvedValue(null);

      await expect(service.refresh(rawToken)).rejects.toThrow(UnauthorizedException);
    });

    it('revokes all sessions and throws on revoked token reuse', async () => {
      prismaMock.refreshToken.findUnique.mockResolvedValue({
        ...storedToken,
        revokedAt: new Date(Date.now() - 1000),
      });

      await expect(service.refresh(rawToken)).rejects.toThrow(UnauthorizedException);

      expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'user-1', revokedAt: null }),
          data: expect.objectContaining({ revokedAt: expect.any(Date) }),
        }),
      );
    });

    it('throws UnauthorizedException for an expired token', async () => {
      prismaMock.refreshToken.findUnique.mockResolvedValue({
        ...storedToken,
        expiresAt: new Date(Date.now() - 1000),
      });

      await expect(service.refresh(rawToken)).rejects.toThrow(UnauthorizedException);
    });

    it('revokes all sessions and throws for an inactive user', async () => {
      prismaMock.refreshToken.findUnique.mockResolvedValue({
        ...storedToken,
        user: { ...storedToken.user, isActive: false },
      });

      await expect(service.refresh(rawToken)).rejects.toThrow(UnauthorizedException);

      expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'user-1', revokedAt: null }),
        }),
      );
    });

    it('revokes all sessions and throws for a soft-deleted user', async () => {
      prismaMock.refreshToken.findUnique.mockResolvedValue({
        ...storedToken,
        user: { ...storedToken.user, deletedAt: new Date() },
      });

      await expect(service.refresh(rawToken)).rejects.toThrow(UnauthorizedException);
    });
  });

  // ── logout ──────────────────────────────────────────────────────────────────

  describe('logout', () => {
    beforeEach(() => {
      prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 1 });
    });

    it('revokes the matching refresh token', async () => {
      await service.logout('user-1', 'raw-token');

      expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'user-1', revokedAt: null }),
          data: expect.objectContaining({ revokedAt: expect.any(Date) }),
        }),
      );
    });

    it('returns { success: true }', async () => {
      await expect(service.logout('user-1', 'raw-token')).resolves.toEqual({
        success: true,
      });
    });

    it('logs a USER_LOGOUT audit event with the correct actorUserId', async () => {
      await service.logout('user-1', 'raw-token');

      expect(auditLogMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'USER_LOGOUT', actorUserId: 'user-1' }),
      );
    });

    it('is idempotent — does not throw when the token is already revoked', async () => {
      prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.logout('user-1', 'already-revoked-token')).resolves.toEqual({
        success: true,
      });
    });
  });

  // ── completeProfile ─────────────────────────────────────────────────────────

  describe('completeProfile', () => {
    const dto = {
      clinicName: 'New Clinic',
      firstName: 'Maria',
      lastName: 'Santos',
      acceptedTerms: true as const,
    };

    const incompleteUser = {
      id: 'user-1',
      googleId: 'google-sub-123',
      clinicId: null as string | null,
      role: 'PATIENT' as const,
    };

    const completedUser = {
      id: 'user-1',
      clinicId: 'clinic-2',
      email: 'maria@gmail.com',
      firstName: 'Maria',
      lastName: 'Santos',
      role: 'OWNER' as const,
      isProfileComplete: true,
      tokenVersion: 1,
    };

    beforeEach(() => {
      prismaMock.user.findFirst.mockResolvedValue(incompleteUser);
      txMock.clinic.create.mockResolvedValue({ id: 'clinic-2' });
      txMock.user.update.mockResolvedValue(completedUser);
      txMock.termsAcceptance.create.mockResolvedValue(undefined);
      txMock.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      txMock.refreshToken.deleteMany.mockResolvedValue({ count: 0 });
      txMock.refreshToken.create.mockResolvedValue(undefined);
    });

    it('returns a new AuthResponse with the updated role and fresh tokens', async () => {
      const result = await service.completeProfile('user-1', dto);

      expect(result).toMatchObject({
        accessToken: 'signed-access-token',
        refreshToken: expect.any(String),
        user: expect.objectContaining({ role: 'OWNER', isProfileComplete: true }),
      });
    });

    it('revokes all existing tokens for the user inside the transaction', async () => {
      await service.completeProfile('user-1', dto);

      expect(txMock.refreshToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'user-1', revokedAt: null }),
          data: expect.objectContaining({ revokedAt: expect.any(Date) }),
        }),
      );
    });

    it('logs USER_UPDATED and TERMS_ACCEPTED audit events', async () => {
      await service.completeProfile('user-1', dto);

      const actions = (auditLogMock.log.mock.calls as [{ action: string }][]).map(
        ([input]) => input.action,
      );
      expect(actions).toContain('USER_UPDATED');
      expect(actions).toContain('TERMS_ACCEPTED');
    });

    it('throws ForbiddenException when the user is not found or profile is already complete', async () => {
      prismaMock.user.findFirst.mockResolvedValue(null);

      await expect(service.completeProfile('user-1', dto)).rejects.toThrow(ForbiddenException);
    });

    it('throws ForbiddenException when the user has no googleId', async () => {
      prismaMock.user.findFirst.mockResolvedValue({ ...incompleteUser, googleId: null });

      await expect(service.completeProfile('user-1', dto)).rejects.toThrow(ForbiddenException);
    });

    it('throws ForbiddenException when the user already belongs to a clinic', async () => {
      prismaMock.user.findFirst.mockResolvedValue({
        ...incompleteUser,
        clinicId: 'existing-clinic',
      });

      await expect(service.completeProfile('user-1', dto)).rejects.toThrow(ForbiddenException);
    });

    it('throws ForbiddenException when the user role is not PATIENT', async () => {
      prismaMock.user.findFirst.mockResolvedValue({ ...incompleteUser, role: 'OWNER' });

      await expect(service.completeProfile('user-1', dto)).rejects.toThrow(ForbiddenException);
    });
  });
});
