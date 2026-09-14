// auth.config throws at import time when JWT_SECRET is absent.
jest.mock('../../config/auth.config', () => ({
  authConfig: {
    jwtSecret: 'test-secret-key',
    jwtExpiresIn: '15m',
    jwtRefreshExpiresIn: '7d',
  },
}));

// The main auth suite pins this to `enabled: false`, which is why every Google
// path below was unreachable there. Here it is on, and individual tests turn it
// off again by mutating the object.
jest.mock('../../config/google-auth.config', () => ({
  googleAuthConfig: {
    enabled: true,
    clientId: 'google-client-id',
    clientSecret: 'google-client-secret',
    callbackUrl: 'http://localhost:3000/api/auth/google/callback',
  },
}));

jest.mock('bcrypt');

import {
  BadRequestException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';

import { AuthService } from './auth.service';
import { googleAuthConfig } from '../../config/google-auth.config';

/** The config object is readonly to callers; the mock behind it is not. */
const mutableConfig = googleAuthConfig as { enabled: boolean };

/**
 * Signing in with Google.
 *
 * This is an authentication surface and it had no test at all. The risk it
 * carries is specific: the callback finds an existing account **by email
 * address**, and Google is the only thing asserting that the person holds that
 * address. Every guard around that lookup — the verified-email requirement,
 * the refusal when the account is already bound to a different Google
 * identity, the refusal for deactivated and soft-deleted accounts — is what
 * stands between a stranger and someone else's clinic.
 *
 * Only `fetch` is stubbed. The state handling, the account matching and the
 * decision to link or create are the real service.
 */

const STATE = 'a'.repeat(64);
const CODE = 'google-auth-code';

type Mocked = Record<string, jest.Mock>;

function createPrisma() {
  return {
    user: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
    },
    authOAuthState: {
      create: jest.fn().mockResolvedValue({ id: 'state-1' }),
      findUnique: jest.fn(),
      delete: jest.fn().mockResolvedValue({ id: 'state-1' }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    refreshToken: {
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };
}

/** A stored user row, shaped as `authUserSelect` returns it. */
function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    clinicId: 'clinic-1',
    email: 'ana@example.test',
    firstName: 'Ana',
    lastName: 'Souza',
    role: 'OWNER',
    isProfileComplete: true,
    tokenVersion: 0,
    ...overrides,
  };
}

/** The row the callback's own lookup selects, which carries more fields. */
function existingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    clinicId: 'clinic-1',
    email: 'ana@example.test',
    firstName: 'Ana',
    lastName: 'Souza',
    role: 'OWNER',
    isActive: true,
    deletedAt: null,
    tokenVersion: 0,
    googleId: null,
    isProfileComplete: true,
    ...overrides,
  };
}

function googleProfile(overrides: Record<string, unknown> = {}) {
  return {
    sub: 'google-sub-1',
    email: 'ana@example.test',
    email_verified: true,
    given_name: 'Ana',
    family_name: 'Souza',
    name: 'Ana Souza',
    picture: 'https://lh3.googleusercontent.com/a/photo',
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: { ok?: boolean } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.ok === false ? 400 : 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('AuthService — signing in with Google', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let service: AuthService;
  let fetchSpy: jest.SpyInstance;
  let auditLog: Mocked;
  let accessPolicy: Mocked;
  let jwt: Mocked;

  beforeEach(() => {
    mutableConfig.enabled = true;

    prisma = createPrisma();
    jwt = { sign: jest.fn().mockReturnValue('signed-access-token') };
    accessPolicy = { assertValidRoleTenantShape: jest.fn() };
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };

    prisma.$transaction.mockImplementation(
      (cb: (tx: unknown) => Promise<unknown>) =>
        cb({
          refreshToken: {
            create: jest.fn().mockResolvedValue({}),
            deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          },
        }),
    );

    (bcrypt.hash as jest.Mock).mockResolvedValue('hashed');

    service = new AuthService(
      prisma as never,
      jwt as never,
      accessPolicy as never,
      auditLog as never,
      {
        assertCanAttempt: jest.fn(),
        recordFailure: jest.fn(),
        reset: jest.fn(),
      } as never,
      { sendPasswordResetEmail: jest.fn() } as never,
    );

    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('unexpected network call'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** A live, unexpired OAuth state. */
  function liveState() {
    prisma.authOAuthState.findUnique.mockResolvedValue({
      id: 'state-1',
      expiresAt: new Date(Date.now() + 60_000),
    });
  }

  /** Google answers the token exchange, then the userinfo call. */
  function googleAnswers(profile: Record<string, unknown> = googleProfile()) {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ access_token: 'google-access' }))
      .mockResolvedValueOnce(jsonResponse(profile));
  }

  // ── Starting the flow ──────────────────────────────────────────────────────

  describe('createGoogleAuthUrl', () => {
    it('issues a consent URL carrying a freshly stored state', async () => {
      const url = new URL(await service.createGoogleAuthUrl());

      const stored = prisma.authOAuthState.create.mock.calls[0][0] as {
        data: { state: string; expiresAt: Date };
      };
      expect(url.origin + url.pathname).toBe(
        'https://accounts.google.com/o/oauth2/v2/auth',
      );
      expect(url.searchParams.get('state')).toBe(stored.data.state);
      expect(url.searchParams.get('client_id')).toBe('google-client-id');
      expect(url.searchParams.get('redirect_uri')).toBe(
        'http://localhost:3000/api/auth/google/callback',
      );
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('scope')).toBe('openid email profile');
    });

    it('asks Google to let the user pick an account', async () => {
      const url = new URL(await service.createGoogleAuthUrl());

      // Without this, a shared browser silently reuses whoever signed in last.
      expect(url.searchParams.get('prompt')).toBe('select_account');
    });

    it('issues an unguessable state', async () => {
      await service.createGoogleAuthUrl();
      await service.createGoogleAuthUrl();

      const first = (
        prisma.authOAuthState.create.mock.calls[0][0] as {
          data: { state: string };
        }
      ).data.state;
      const second = (
        prisma.authOAuthState.create.mock.calls[1][0] as {
          data: { state: string };
        }
      ).data.state;

      expect(first).toHaveLength(64);
      expect(first).toMatch(/^[0-9a-f]+$/);
      expect(second).not.toBe(first);
    });

    it('gives the state a bounded lifetime', async () => {
      const before = Date.now();
      await service.createGoogleAuthUrl();
      const after = Date.now();

      const { expiresAt } = (
        prisma.authOAuthState.create.mock.calls[0][0] as {
          data: { expiresAt: Date };
        }
      ).data;

      expect(expiresAt.getTime()).toBeGreaterThan(before + 9 * 60_000);
      expect(expiresAt.getTime()).toBeLessThanOrEqual(after + 10 * 60_000);
    });

    it('sweeps expired states as it goes', async () => {
      await service.createGoogleAuthUrl();

      const where = (
        prisma.authOAuthState.deleteMany.mock.calls[0][0] as {
          where: { expiresAt: { lt: Date } };
        }
      ).where;
      expect(where.expiresAt.lt).toBeInstanceOf(Date);
    });

    it('refuses when Google sign-in is switched off', async () => {
      mutableConfig.enabled = false;

      await expect(service.createGoogleAuthUrl()).rejects.toThrow(
        InternalServerErrorException,
      );
      expect(prisma.authOAuthState.create).not.toHaveBeenCalled();
    });
  });

  // ── The state parameter ────────────────────────────────────────────────────

  describe('the callback state', () => {
    it('refuses a callback with no code', async () => {
      await expect(
        service.handleGoogleCallback(undefined, STATE),
      ).rejects.toThrow(BadRequestException);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('refuses a callback with no state', async () => {
      await expect(
        service.handleGoogleCallback(CODE, undefined),
      ).rejects.toThrow(BadRequestException);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('refuses a state this server never issued', async () => {
      prisma.authOAuthState.findUnique.mockResolvedValue(null);

      // Without this the callback is an open redirect target: anyone could
      // replay a code against it.
      await expect(service.handleGoogleCallback(CODE, STATE)).rejects.toThrow(
        BadRequestException,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('refuses a state that has expired', async () => {
      prisma.authOAuthState.findUnique.mockResolvedValue({
        id: 'state-1',
        expiresAt: new Date(Date.now() - 1_000),
      });

      await expect(service.handleGoogleCallback(CODE, STATE)).rejects.toThrow(
        BadRequestException,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('consumes the state before exchanging the code', async () => {
      liveState();
      googleAnswers();
      prisma.user.findFirst.mockResolvedValue(existingRow());
      prisma.user.update.mockResolvedValue(userRow());

      await service.handleGoogleCallback(CODE, STATE);

      // Single use: a replayed callback must not find the state still there.
      expect(prisma.authOAuthState.delete).toHaveBeenCalledWith({
        where: { id: 'state-1' },
      });
      const deleteOrder =
        prisma.authOAuthState.delete.mock.invocationCallOrder[0];
      expect(deleteOrder).toBeLessThan(fetchSpy.mock.invocationCallOrder[0]);
    });

    it('refuses when Google sign-in is switched off', async () => {
      mutableConfig.enabled = false;

      await expect(service.handleGoogleCallback(CODE, STATE)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  // ── Talking to Google ──────────────────────────────────────────────────────

  describe('the exchange with Google', () => {
    it('posts the code to the token endpoint', async () => {
      liveState();
      googleAnswers();
      prisma.user.findFirst.mockResolvedValue(existingRow());
      prisma.user.update.mockResolvedValue(userRow());

      await service.handleGoogleCallback(CODE, STATE);

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://oauth2.googleapis.com/token');
      expect(init.method).toBe('POST');
      const body = new URLSearchParams(init.body as string);
      expect(body.get('code')).toBe(CODE);
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('client_secret')).toBe('google-client-secret');
    });

    it('reads the profile with the access token it just received', async () => {
      liveState();
      googleAnswers();
      prisma.user.findFirst.mockResolvedValue(existingRow());
      prisma.user.update.mockResolvedValue(userRow());

      await service.handleGoogleCallback(CODE, STATE);

      const [url, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
      expect(url).toBe('https://openidconnect.googleapis.com/v1/userinfo');
      expect((init.headers as Record<string, string>).Authorization).toBe(
        'Bearer google-access',
      );
    });

    it('refuses when the token endpoint rejects the code', async () => {
      liveState();
      fetchSpy.mockResolvedValue(
        jsonResponse({ error: 'invalid_grant' }, { ok: false }),
      );

      await expect(service.handleGoogleCallback(CODE, STATE)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('refuses when the exchange returns no access token', async () => {
      liveState();
      fetchSpy.mockResolvedValueOnce(jsonResponse({ token_type: 'Bearer' }));

      await expect(service.handleGoogleCallback(CODE, STATE)).rejects.toThrow(
        BadRequestException,
      );
      // The profile was never requested.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('refuses when the profile endpoint rejects the token', async () => {
      liveState();
      fetchSpy
        .mockResolvedValueOnce(jsonResponse({ access_token: 'google-access' }))
        .mockResolvedValueOnce(jsonResponse({}, { ok: false }));

      await expect(service.handleGoogleCallback(CODE, STATE)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── What Google has to assert about the person ─────────────────────────────

  describe('the identity Google returns', () => {
    async function callbackWith(profile: Record<string, unknown>) {
      liveState();
      googleAnswers(profile);
      return service.handleGoogleCallback(CODE, STATE);
    }

    it('refuses an unverified email address', async () => {
      // The account lookup is by email. An unverified address would let anyone
      // who can create a Google account claim someone else's clinic login.
      await expect(
        callbackWith(googleProfile({ email_verified: false })),
      ).rejects.toThrow(UnauthorizedException);
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
    });

    it('refuses a profile whose verified flag is merely truthy', async () => {
      await expect(
        callbackWith(googleProfile({ email_verified: 'true' })),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('refuses a profile with no subject id', async () => {
      await expect(
        callbackWith(googleProfile({ sub: undefined })),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('refuses a profile with no email', async () => {
      await expect(
        callbackWith(googleProfile({ email: undefined })),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('matches the account on a normalised email address', async () => {
      prisma.user.findFirst.mockResolvedValue(existingRow());
      prisma.user.update.mockResolvedValue(userRow());

      await callbackWith(googleProfile({ email: '  Ana@Example.TEST ' }));

      expect(prisma.user.findFirst.mock.calls[0][0].where).toEqual({
        email: 'ana@example.test',
      });
    });
  });

  // ── An account that already exists ─────────────────────────────────────────

  describe('an existing account', () => {
    beforeEach(() => {
      liveState();
      googleAnswers();
    });

    it('links the Google identity and signs the user in', async () => {
      prisma.user.findFirst.mockResolvedValue(existingRow());
      prisma.user.update.mockResolvedValue(userRow());

      const result = await service.handleGoogleCallback(CODE, STATE);

      const update = prisma.user.update.mock.calls[0][0] as {
        where: { id: string };
        data: Record<string, unknown>;
      };
      expect(update.where).toEqual({ id: 'user-1' });
      expect(update.data).toMatchObject({
        googleId: 'google-sub-1',
        isEmailVerified: true,
      });
      expect(result.accessToken).toBe('signed-access-token');
      expect(typeof result.refreshToken).toBe('string');
    });

    it('never returns the password hash or the token version to the client', async () => {
      prisma.user.findFirst.mockResolvedValue(existingRow());
      prisma.user.update.mockResolvedValue(userRow());

      const result = await service.handleGoogleCallback(CODE, STATE);

      expect(Object.keys(result.user).sort()).toEqual([
        'clinicId',
        'email',
        'firstName',
        'id',
        'isProfileComplete',
        'lastName',
        'role',
      ]);
    });

    it('keeps the Google id it was already bound to', async () => {
      prisma.user.findFirst.mockResolvedValue(
        existingRow({ googleId: 'google-sub-1' }),
      );
      prisma.user.update.mockResolvedValue(userRow());

      await service.handleGoogleCallback(CODE, STATE);

      const data = (
        prisma.user.update.mock.calls[0][0] as { data: { googleId: string } }
      ).data;
      expect(data.googleId).toBe('google-sub-1');
    });

    it('refuses when the account is bound to a different Google identity', async () => {
      prisma.user.findFirst.mockResolvedValue(
        existingRow({ googleId: 'someone-elses-sub' }),
      );

      // Two Google accounts can end up presenting the same email over time.
      // Re-binding silently would hand the account to the second one.
      await expect(service.handleGoogleCallback(CODE, STATE)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('refuses a deactivated account', async () => {
      prisma.user.findFirst.mockResolvedValue(existingRow({ isActive: false }));

      await expect(service.handleGoogleCallback(CODE, STATE)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('refuses a soft-deleted account', async () => {
      prisma.user.findFirst.mockResolvedValue(
        existingRow({ deletedAt: new Date('2026-01-01T00:00:00.000Z') }),
      );

      await expect(service.handleGoogleCallback(CODE, STATE)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('refuses a patient who has already completed their profile', async () => {
      prisma.user.findFirst.mockResolvedValue(
        existingRow({ role: 'PATIENT', isProfileComplete: true }),
      );

      await expect(service.handleGoogleCallback(CODE, STATE)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('lets a patient who has not finished signing up continue', async () => {
      prisma.user.findFirst.mockResolvedValue(
        existingRow({
          role: 'PATIENT',
          clinicId: null,
          isProfileComplete: false,
        }),
      );
      prisma.user.update.mockResolvedValue(
        userRow({ role: 'PATIENT', clinicId: null, isProfileComplete: false }),
      );

      const result = await service.handleGoogleCallback(CODE, STATE);

      expect(result.user.isProfileComplete).toBe(false);
    });

    it('checks the role and tenancy shape before issuing a token', async () => {
      prisma.user.findFirst.mockResolvedValue(existingRow());
      prisma.user.update.mockResolvedValue(userRow());

      await service.handleGoogleCallback(CODE, STATE);

      expect(accessPolicy.assertValidRoleTenantShape).toHaveBeenCalledWith({
        id: 'user-1',
        clinicId: 'clinic-1',
        role: 'OWNER',
      });
    });

    it('records the sign-in as coming from Google', async () => {
      prisma.user.findFirst.mockResolvedValue(existingRow());
      prisma.user.update.mockResolvedValue(userRow());

      await service.handleGoogleCallback(CODE, STATE);

      expect(auditLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'USER_LOGIN_SUCCESS',
          metadata: { source: 'google' },
        }),
      );
    });
  });

  // ── A person Google knows and DentalFlow does not ──────────────────────────

  describe('a new account', () => {
    beforeEach(() => {
      liveState();
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(
        userRow({ role: 'PATIENT', clinicId: null, isProfileComplete: false }),
      );
    });

    it('creates a patient who still has to finish signing up', async () => {
      googleAnswers();

      await service.handleGoogleCallback(CODE, STATE);

      const data = (
        prisma.user.create.mock.calls[0][0] as { data: Record<string, unknown> }
      ).data;
      expect(data).toMatchObject({
        email: 'ana@example.test',
        role: 'PATIENT',
        googleId: 'google-sub-1',
        isEmailVerified: true,
        isProfileComplete: false,
      });
      // No clinic is inferred from a Google profile.
      expect(data.clinicId).toBeUndefined();
    });

    it('gives the account an unusable password rather than none', async () => {
      googleAnswers();

      await service.handleGoogleCallback(CODE, STATE);

      // A blank or absent hash would make the password login path a way in.
      const [secret, rounds] = (bcrypt.hash as jest.Mock).mock.calls[0] as [
        string,
        number,
      ];
      expect(secret).toHaveLength(64);
      expect(rounds).toBe(12);
      const data = (
        prisma.user.create.mock.calls[0][0] as {
          data: { passwordHash: string };
        }
      ).data;
      expect(data.passwordHash).toBe('hashed');
    });

    it('records where the account came from', async () => {
      googleAnswers();

      await service.handleGoogleCallback(CODE, STATE);

      expect(auditLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'USER_CREATED',
          metadata: { source: 'google_oauth', requiresProfileCompletion: true },
        }),
      );
    });

    it('truncates an over-long avatar URL instead of failing the sign-in', async () => {
      googleAnswers(
        googleProfile({ picture: `https://x/${'a'.repeat(4000)}` }),
      );

      await service.handleGoogleCallback(CODE, STATE);

      const data = (
        prisma.user.create.mock.calls[0][0] as { data: { avatarUrl: string } }
      ).data;
      expect(data.avatarUrl).toHaveLength(2048);
    });

    it('stores no avatar when Google sends none', async () => {
      googleAnswers(googleProfile({ picture: undefined }));

      await service.handleGoogleCallback(CODE, STATE);

      const data = (
        prisma.user.create.mock.calls[0][0] as { data: { avatarUrl: null } }
      ).data;
      expect(data.avatarUrl).toBeNull();
    });
  });

  // ── Turning a Google profile into a name ───────────────────────────────────

  describe('the name taken from the profile', () => {
    async function nameFrom(profile: Record<string, unknown>) {
      liveState();
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(userRow());
      googleAnswers(googleProfile(profile));

      await service.handleGoogleCallback(CODE, STATE);

      return (
        prisma.user.create.mock.calls[0][0] as {
          data: { firstName: string; lastName: string };
        }
      ).data;
    }

    it('prefers the given and family names Google supplies', async () => {
      await expect(
        nameFrom({ given_name: 'Ana', family_name: 'Souza', name: 'Ignored' }),
      ).resolves.toMatchObject({ firstName: 'Ana', lastName: 'Souza' });
    });

    it('splits the display name when the parts are missing', async () => {
      await expect(
        nameFrom({
          given_name: undefined,
          family_name: undefined,
          name: 'Ana Beatriz Souza',
        }),
      ).resolves.toMatchObject({
        firstName: 'Ana',
        lastName: 'Beatriz Souza',
      });
    });

    it('accepts a single-word name with no surname', async () => {
      await expect(
        nameFrom({
          given_name: undefined,
          family_name: undefined,
          name: 'Ana',
        }),
      ).resolves.toMatchObject({ firstName: 'Ana', lastName: '' });
    });

    it('falls back to a placeholder when Google sends no name at all', async () => {
      await expect(
        nameFrom({
          given_name: undefined,
          family_name: undefined,
          name: undefined,
        }),
      ).resolves.toMatchObject({ firstName: 'Usuário', lastName: '' });
    });

    it('keeps the given name when only the surname is missing', async () => {
      await expect(
        nameFrom({
          given_name: 'Ana',
          family_name: undefined,
          name: undefined,
        }),
      ).resolves.toMatchObject({ firstName: 'Ana', lastName: '' });
    });

    it('trims whitespace Google left in the parts', async () => {
      await expect(
        nameFrom({ given_name: '  Ana  ', family_name: '  Souza  ' }),
      ).resolves.toMatchObject({ firstName: 'Ana', lastName: 'Souza' });
    });

    it('caps each part at the column width', async () => {
      const long = 'A'.repeat(120);
      const name = await nameFrom({ given_name: long, family_name: long });

      expect(name.firstName).toHaveLength(50);
      expect(name.lastName).toHaveLength(50);
    });
  });
});
