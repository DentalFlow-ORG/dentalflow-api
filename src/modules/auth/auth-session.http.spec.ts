import { AuthService } from './auth.service';
import { createHarness, Harness, USERS } from '../../../test/support/http-harness';

/**
 * AUTHENTICATION AND SESSION SECURITY (HTTP boundary)
 *
 * AuthService's own suite covers the token lifecycle — rotation, reuse
 * detection, expiry, revocation on password change. What only exists at the
 * HTTP boundary, and is covered here, is everything around it:
 *
 *   - how the refresh cookie is written (httpOnly, SameSite, Secure, path,
 *     lifetime) — the attributes that decide whether the token is reachable
 *     from script or replayable cross-site;
 *   - the Origin check that stands in for SameSite on the cookie-authenticated
 *     routes now that the cookie is SameSite=None in production;
 *   - what JwtStrategy rejects: expired, malformed, foreign-signed, stale
 *     tokenVersion, deactivated and soft-deleted accounts;
 *   - that none of the above leaks a token or a secret into a response.
 */

const TRUSTED_ORIGIN = 'http://localhost:5173';
const HOSTILE_ORIGIN = 'https://evil.example';

type CookieAttributes = Record<string, string | true>;

function parseSetCookie(header: string | string[] | undefined): CookieAttributes | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;

  const attributes: CookieAttributes = {};
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    attributes[key.toLowerCase()] = rest.length ? rest.join('=') : true;
  }
  return attributes;
}

describe('Authentication and session security', () => {
  let harness: Harness;
  let auth: AuthService;

  beforeAll(async () => {
    harness = await createHarness();
    auth = harness.app.get(AuthService);
  }, 120_000);

  afterAll(async () => {
    await harness.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    harness.prisma.__reset();
  });

  const session = {
    accessToken: 'issued-access-token',
    refreshToken: 'issued-refresh-token',
    user: { id: 'u1', email: 'owner@example.test', role: 'OWNER' },
  };

  // ── Refresh cookie ─────────────────────────────────────────────────────────

  describe('refresh cookie', () => {
    it('is issued on sign-in as an httpOnly cookie scoped to the auth routes', async () => {
      jest.spyOn(auth, 'signIn').mockResolvedValue(session as never);

      const res = await harness
        .post('/auth/login')
        .send({ email: 'owner@example.test', password: 'Sup3rSecret!' });

      expect(res.status).toBe(200);
      const cookie = parseSetCookie(res.headers['set-cookie']);
      expect(cookie).not.toBeNull();
      expect(cookie!['refresh_token']).toBe('issued-refresh-token');
      expect(cookie!['httponly']).toBe(true);
      expect(cookie!['path']).toBe('/api/auth');
    });

    it('is not readable from the JSON body — only the access token is returned', async () => {
      jest.spyOn(auth, 'signIn').mockResolvedValue(session as never);

      const res = await harness
        .post('/auth/login')
        .send({ email: 'owner@example.test', password: 'Sup3rSecret!' });

      expect(res.body.accessToken).toBe('issued-access-token');
      expect(JSON.stringify(res.body)).not.toContain('issued-refresh-token');
      expect(res.body).not.toHaveProperty('refreshToken');
    });

    it('uses SameSite=Lax without Secure outside production (same-site dev)', async () => {
      jest.spyOn(auth, 'signIn').mockResolvedValue(session as never);

      const res = await harness
        .post('/auth/login')
        .send({ email: 'owner@example.test', password: 'Sup3rSecret!' });

      const cookie = parseSetCookie(res.headers['set-cookie'])!;
      expect(String(cookie['samesite']).toLowerCase()).toBe('lax');
      expect(cookie['secure']).toBeUndefined();
    });

    it('carries an expiry derived from the configured refresh lifetime', async () => {
      jest.spyOn(auth, 'signIn').mockResolvedValue(session as never);

      const res = await harness
        .post('/auth/login')
        .send({ email: 'owner@example.test', password: 'Sup3rSecret!' });

      const cookie = parseSetCookie(res.headers['set-cookie'])!;
      // JWT_REFRESH_EXPIRES_IN is 7d in the test environment.
      const maxAge = Number(cookie['max-age']);
      expect(maxAge).toBe(7 * 24 * 60 * 60);
    });

    it('is rotated on refresh rather than reused', async () => {
      jest.spyOn(auth, 'refresh').mockResolvedValue({
        accessToken: 'rotated-access',
        refreshToken: 'rotated-refresh',
      } as never);

      const res = await harness
        .post('/auth/refresh')
        .set('Origin', TRUSTED_ORIGIN)
        .set('Cookie', 'refresh_token=old-refresh');

      expect(res.status).toBe(200);
      const cookie = parseSetCookie(res.headers['set-cookie'])!;
      expect(cookie['refresh_token']).toBe('rotated-refresh');
      expect(res.body).toEqual({ accessToken: 'rotated-access' });
    });

    it('is cleared on logout', async () => {
      jest.spyOn(auth, 'logout').mockResolvedValue({ success: true } as never);
      const token = harness.tokenFor(USERS.ownerA);

      const res = await harness
        .post('/auth/logout')
        .set('Authorization', `Bearer ${token}`)
        .set('Origin', TRUSTED_ORIGIN)
        .set('Cookie', 'refresh_token=current-refresh');

      expect(res.status).toBe(200);
      const cookie = parseSetCookie(res.headers['set-cookie'])!;
      expect(cookie['refresh_token']).toBe('');
    });
  });

  // ── Refresh without a usable cookie ────────────────────────────────────────

  describe('refresh preconditions', () => {
    it('rejects a refresh with no cookie', async () => {
      const res = await harness.post('/auth/refresh').set('Origin', TRUSTED_ORIGIN);
      expect(res.status).toBe(401);
    });

    it('rejects a refresh whose cookie header carries no refresh_token', async () => {
      const res = await harness
        .post('/auth/refresh')
        .set('Origin', TRUSTED_ORIGIN)
        .set('Cookie', 'other=value; session=abc');
      expect(res.status).toBe(401);
    });

    it('does not consult the token store when no cookie is present', async () => {
      const refresh = jest.spyOn(auth, 'refresh');
      await harness.post('/auth/refresh').set('Origin', TRUSTED_ORIGIN);
      expect(refresh).not.toHaveBeenCalled();
    });

    it('url-decodes the cookie value before validating it', async () => {
      const refresh = jest
        .spyOn(auth, 'refresh')
        .mockResolvedValue({ accessToken: 'a', refreshToken: 'b' } as never);

      await harness
        .post('/auth/refresh')
        .set('Origin', TRUSTED_ORIGIN)
        .set('Cookie', 'refresh_token=a%2Bb%3Dc');

      expect(refresh).toHaveBeenCalledWith('a+b=c', expect.anything());
    });
  });

  // ── Cross-site request forgery ─────────────────────────────────────────────

  describe('Origin enforcement on cookie-authenticated routes', () => {
    it('rejects a refresh from an untrusted Origin', async () => {
      const refresh = jest.spyOn(auth, 'refresh');

      const res = await harness
        .post('/auth/refresh')
        .set('Origin', HOSTILE_ORIGIN)
        .set('Cookie', 'refresh_token=stolen');

      expect(res.status).toBe(403);
      expect(refresh).not.toHaveBeenCalled();
    });

    it('rejects a logout from an untrusted Origin', async () => {
      const logout = jest.spyOn(auth, 'logout');
      const token = harness.tokenFor(USERS.ownerA);

      const res = await harness
        .post('/auth/logout')
        .set('Authorization', `Bearer ${token}`)
        .set('Origin', HOSTILE_ORIGIN)
        .set('Cookie', 'refresh_token=current');

      expect(res.status).toBe(403);
      expect(logout).not.toHaveBeenCalled();
    });

    it('does not clear the cookie when the Origin is rejected', async () => {
      const token = harness.tokenFor(USERS.ownerA);

      const res = await harness
        .post('/auth/logout')
        .set('Authorization', `Bearer ${token}`)
        .set('Origin', HOSTILE_ORIGIN)
        .set('Cookie', 'refresh_token=current');

      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('allows a request with no Origin header (non-browser caller)', async () => {
      jest
        .spyOn(auth, 'refresh')
        .mockResolvedValue({ accessToken: 'a', refreshToken: 'b' } as never);

      const res = await harness
        .post('/auth/refresh')
        .set('Cookie', 'refresh_token=valid');

      expect(res.status).toBe(200);
    });
  });

  // ── Logout ─────────────────────────────────────────────────────────────────

  describe('logout', () => {
    it('succeeds and clears the cookie even when no refresh token is presented', async () => {
      const logout = jest.spyOn(auth, 'logout');
      const token = harness.tokenFor(USERS.ownerA);

      const res = await harness
        .post('/auth/logout')
        .set('Authorization', `Bearer ${token}`)
        .set('Origin', TRUSTED_ORIGIN);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      // Nothing to revoke, so the store is not touched.
      expect(logout).not.toHaveBeenCalled();
      expect(parseSetCookie(res.headers['set-cookie'])!['refresh_token']).toBe('');
    });

    it('requires authentication', async () => {
      const res = await harness.post('/auth/logout').set('Origin', TRUSTED_ORIGIN);
      expect(res.status).toBe(401);
    });

    it('revokes the presented token for the authenticated user only', async () => {
      const logout = jest
        .spyOn(auth, 'logout')
        .mockResolvedValue({ success: true } as never);
      const token = harness.tokenFor(USERS.ownerA);

      await harness
        .post('/auth/logout')
        .set('Authorization', `Bearer ${token}`)
        .set('Origin', TRUSTED_ORIGIN)
        .set('Cookie', 'refresh_token=mine');

      expect(logout).toHaveBeenCalledWith(USERS.ownerA.id, 'mine', expect.anything());
    });
  });

  // ── Access-token validation ────────────────────────────────────────────────

  describe('access token validation', () => {
    const PROTECTED = '/users/me';

    it('accepts a token for an active, registered user', async () => {
      const token = harness.tokenFor(USERS.ownerA);
      const res = await harness.get(PROTECTED).set('Authorization', `Bearer ${token}`);
      expect(res.status).not.toBe(401);
    });

    it('rejects a malformed token', async () => {
      const res = await harness
        .get(PROTECTED)
        .set('Authorization', 'Bearer not-a-jwt');
      expect(res.status).toBe(401);
    });

    it('rejects a token signed with a different secret', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { JwtService } = require('@nestjs/jwt') as typeof import('@nestjs/jwt');
      const foreign = new JwtService({ secret: 'a-different-secret-entirely' });
      const token = foreign.sign({
        sub: USERS.ownerA.id,
        clinicId: USERS.ownerA.clinicId,
        role: 'OWNER',
        tokenVersion: 0,
      });

      const res = await harness.get(PROTECTED).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    });

    it('rejects an expired token', async () => {
      harness.tokenFor(USERS.ownerA);
      const expired = harness.signRaw(
        {
          sub: USERS.ownerA.id,
          clinicId: USERS.ownerA.clinicId,
          role: 'OWNER',
          tokenVersion: 0,
        },
        { expiresIn: '-1s' },
      );

      const res = await harness.get(PROTECTED).set('Authorization', `Bearer ${expired}`);
      expect(res.status).toBe(401);
    });

    it('rejects a token whose subject no longer exists', async () => {
      const orphan = harness.signRaw({
        sub: 'user-that-was-deleted',
        clinicId: null,
        role: 'ADMIN',
        tokenVersion: 0,
      });

      const res = await harness.get(PROTECTED).set('Authorization', `Bearer ${orphan}`);
      expect(res.status).toBe(401);
    });

    it('rejects a token for a deactivated user', async () => {
      const token = harness.tokenFor({ ...USERS.ownerA, id: 'inactive-user', isActive: false });
      const res = await harness.get(PROTECTED).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    });

    it('rejects a token for a soft-deleted user', async () => {
      const token = harness.tokenFor({
        ...USERS.ownerA,
        id: 'deleted-user',
        deletedAt: new Date(),
      });
      const res = await harness.get(PROTECTED).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    });

    it('rejects a token whose tokenVersion is stale (password changed since issue)', async () => {
      // The account is registered at version 3; the token still claims 2.
      harness.tokenFor({ ...USERS.ownerA, id: 'rotated-user', tokenVersion: 3 });
      const stale = harness.signRaw({
        sub: 'rotated-user',
        clinicId: USERS.ownerA.clinicId,
        role: 'OWNER',
        tokenVersion: 2,
      });

      const res = await harness.get(PROTECTED).set('Authorization', `Bearer ${stale}`);
      expect(res.status).toBe(401);
    });

    it('rejects a token whose role/tenant shape is invalid', async () => {
      const token = harness.tokenFor({
        id: 'shape-violation',
        clinicId: 'some-clinic',
        role: 'ADMIN',
      });
      const res = await harness.get(PROTECTED).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it('ignores a clinicId claim in the token and uses the stored one', async () => {
      // The strategy rebuilds AuthUser from the database row, so a forged
      // clinicId in the token body cannot widen access.
      harness.tokenFor({ id: 'claims-user', clinicId: 'real-clinic', role: 'OWNER' });
      const forged = harness.signRaw({
        sub: 'claims-user',
        clinicId: 'victim-clinic',
        role: 'OWNER',
        tokenVersion: 0,
      });

      harness.prisma.profile.findMany.mockResolvedValue([]);
      await harness.get('/profiles').set('Authorization', `Bearer ${forged}`);

      const serialized = JSON.stringify(harness.prisma.profile.findMany.mock.calls);
      expect(serialized).toContain('real-clinic');
      expect(serialized).not.toContain('victim-clinic');
    });
  });

  // ── Leakage ────────────────────────────────────────────────────────────────

  describe('leakage', () => {
    it('does not echo the presented bearer token in an error response', async () => {
      const res = await harness
        .get('/users/me')
        .set('Authorization', 'Bearer leaky-token-value');

      expect(JSON.stringify(res.body)).not.toContain('leaky-token-value');
    });

    it('does not expose the signing secret in any auth response', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { authConfig } = require('../../config/auth.config') as typeof import('../../config/auth.config');
      const res = await harness.post('/auth/refresh').set('Origin', TRUSTED_ORIGIN);
      expect(JSON.stringify(res.body)).not.toContain(authConfig.jwtSecret);
    });

    it('answers a failed sign-in without revealing whether the account exists', async () => {
      jest.spyOn(auth, 'signIn').mockRejectedValue(
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        new (require('@nestjs/common').UnauthorizedException)('Credenciais inválidas'),
      );

      const res = await harness
        .post('/auth/login')
        .send({ email: 'nobody@example.test', password: 'Wr0ngPassword!' });

      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Credenciais inválidas');
    });
  });

  // ── Google sign-in entry points ────────────────────────────────────────────

  describe('Google sign-in', () => {
    it('redirects to a safe frontend fallback when Google auth is disabled', async () => {
      jest
        .spyOn(auth, 'createGoogleAuthUrl')
        .mockRejectedValue(new Error('google auth disabled'));

      const res = await harness.get('/auth/google');

      expect(res.status).toBe(302);
      const url = new URL(res.headers.location);
      expect(url.pathname).toBe('/acessar');
      expect(url.searchParams.get('googleAuth')).toBe('disabled');
    });

    it('redirects to Google when configured', async () => {
      jest
        .spyOn(auth, 'createGoogleAuthUrl')
        .mockResolvedValue('https://accounts.google.com/o/oauth2/v2/auth?x=1');

      const res = await harness.get('/auth/google');
      expect(res.headers.location).toContain('accounts.google.com');
    });

    it('returns to the login page when the user cancels at Google', async () => {
      const res = await harness.get('/auth/google/callback?error=access_denied');

      const url = new URL(res.headers.location);
      expect(url.pathname).toBe('/acessar');
      expect(url.searchParams.get('googleAuth')).toBe('cancelled');
    });

    it('returns to the login page — with no session cookie — when the callback fails', async () => {
      jest
        .spyOn(auth, 'handleGoogleCallback')
        .mockRejectedValue(new Error('state mismatch'));

      const res = await harness.get('/auth/google/callback?code=abc&state=xyz');

      const url = new URL(res.headers.location);
      expect(url.searchParams.get('googleAuth')).toBe('error');
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('sends a completed profile to the success URL with a session cookie', async () => {
      jest.spyOn(auth, 'handleGoogleCallback').mockResolvedValue({
        ...session,
        user: { ...session.user, isProfileComplete: true },
      } as never);

      const res = await harness.get('/auth/google/callback?code=abc&state=xyz');

      expect(res.headers.location).toContain('/acessar/oauth/sucesso');
      expect(parseSetCookie(res.headers['set-cookie'])!['refresh_token']).toBe(
        'issued-refresh-token',
      );
    });

    it('sends an incomplete profile to the complete-profile URL', async () => {
      jest.spyOn(auth, 'handleGoogleCallback').mockResolvedValue({
        ...session,
        user: { ...session.user, isProfileComplete: false },
      } as never);

      const res = await harness.get('/auth/google/callback?code=abc&state=xyz');

      expect(res.headers.location).toContain('/acessar/completar-perfil');
    });
  });
});
