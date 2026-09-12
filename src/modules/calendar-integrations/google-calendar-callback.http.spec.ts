// Configuration must be present before AppModule is imported, otherwise
// assertConfig() short-circuits every flow with a 500 and nothing downstream
// is exercised. Fake values only — no request in this suite leaves the process.
jest.mock('../../config/google-calendar.config', () => ({
  googleCalendarConfig: {
    clientId: 'test-google-client-id',
    clientSecret: 'test-google-client-secret',
    redirectUri: 'http://localhost:3000/api/calendar-integrations/google/callback',
    tokenSecret: 'test-google-token-secret-32-bytes-long',
  },
}));

import { createHarness, Harness, USERS } from '../../../test/support/http-harness';

/**
 * REGRESSION — Google Calendar OAuth callback
 *
 * The callback is @Public: Google calls it directly, so the only thing tying
 * the request to a user is the opaque `state` value. Two properties follow,
 * and both are pinned here.
 *
 * Redirect: a DENTIST connects their own calendar and returns to /app/agenda;
 * an OWNER connects the clinic calendar and returns to /app/agendamentos. The
 * role comes from the stored state, never from the request, and an
 * unknown/expired state must still land somewhere safe rather than 500.
 *
 * Identity: the clinic and user the integration is written for are read out of
 * the stored state row. Nothing a caller can set may influence them.
 */

const CALLBACK = '/calendar-integrations/google/callback';
const OWNER_PATH = '/app/agendamentos';
const DENTIST_PATH = '/app/agenda';

function redirectTarget(location: string): URL {
  return new URL(location);
}

describe('Google Calendar OAuth callback', () => {
  let harness: Harness;
  let fetchSpy: jest.SpyInstance;

  beforeAll(async () => {
    harness = await createHarness();
  }, 120_000);

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    harness.prisma.__reset();
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('network disabled'));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function jsonResponse(body: unknown) {
    return {
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    } as unknown as Response;
  }

  /** Makes only the token exchange and calendar lookup succeed. */
  function grantGoogleTokens() {
    fetchSpy.mockImplementation((input: any) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        return Promise.resolve(
          jsonResponse({
            access_token: 'google-access-token',
            refresh_token: 'google-refresh-token',
            expires_in: 3600,
          }),
        );
      }
      if (url.includes('googleapis.com/calendar')) {
        return Promise.resolve(jsonResponse({ id: 'primary', summary: 'Agenda' }));
      }
      return Promise.reject(new Error(`unexpected call to ${url}`));
    });
  }

  function executedStatements(): string[] {
    return harness.prisma.$executeRaw.mock.calls.map(([parts]: any) =>
      (parts as string[]).join('?'),
    );
  }

  function insertValuesFor(table: string): unknown[] {
    const call = harness.prisma.$executeRaw.mock.calls.find(([parts]: any) =>
      (parts as string[]).join('?').includes(`INSERT INTO "${table}"`),
    );
    expect(call).toBeDefined();
    return (call as unknown[]).slice(1);
  }

  /** The row `resolveCallbackRedirectRole` and `handleCallback` read. */
  function storedState(role: 'OWNER' | 'DENTIST', expiresAt = new Date(Date.now() + 60_000)) {
    return [
      {
        id: 'state-123',
        clinicId: 'clinic-from-state',
        userId: 'user-from-state',
        userRole: role,
        expiresAt,
      },
    ];
  }

  // ── Redirect target by role ────────────────────────────────────────────────

  describe('redirect target', () => {
    it('sends an OWNER back to /app/agendamentos on success', async () => {
      harness.prisma.$queryRaw.mockResolvedValue(storedState('OWNER'));
      grantGoogleTokens();

      const res = await harness.get(`${CALLBACK}?code=abc&state=state-123`);

      expect(res.status).toBe(302);
      const url = redirectTarget(res.headers.location);
      expect(url.pathname).toBe(OWNER_PATH);
      expect(url.searchParams.get('googleCalendar')).toBe('connected');
    });

    it('sends a DENTIST back to /app/agenda on success', async () => {
      harness.prisma.$queryRaw.mockResolvedValue(storedState('DENTIST'));
      grantGoogleTokens();

      const res = await harness.get(`${CALLBACK}?code=abc&state=state-123`);

      const url = redirectTarget(res.headers.location);
      expect(url.pathname).toBe(DENTIST_PATH);
      expect(url.searchParams.get('googleCalendar')).toBe('connected');
    });

    it('writes the clinic integration for an OWNER state and consumes the state', async () => {
      harness.prisma.$queryRaw.mockResolvedValue(storedState('OWNER'));
      grantGoogleTokens();

      await harness.get(`${CALLBACK}?code=abc&state=state-123`);

      const statements = executedStatements();
      expect(
        statements.some((sql) => sql.includes('INSERT INTO "google_calendar_integrations"')),
      ).toBe(true);
      // Single-use: the state row is removed once redeemed.
      expect(
        statements.some((sql) =>
          sql.includes('DELETE FROM "google_calendar_oauth_states"'),
        ),
      ).toBe(true);
    });

    it('writes the per-user integration for a DENTIST state', async () => {
      harness.prisma.$queryRaw.mockResolvedValue(storedState('DENTIST'));
      grantGoogleTokens();

      await harness.get(`${CALLBACK}?code=abc&state=state-123`);

      expect(
        executedStatements().some((sql) =>
          sql.includes('INSERT INTO "user_google_calendar_integrations"'),
        ),
      ).toBe(true);
    });

    it('binds the integration to the clinic and user named by the state, not by the request', async () => {
      harness.prisma.$queryRaw.mockResolvedValue(storedState('DENTIST'));
      grantGoogleTokens();

      await harness.get(
        `${CALLBACK}?code=abc&state=state-123&clinicId=attacker-clinic&userId=attacker-user`,
      );

      const values = insertValuesFor('user_google_calendar_integrations');
      expect(values).toEqual(
        expect.arrayContaining(['user-from-state', 'clinic-from-state']),
      );
      expect(values).not.toContain('attacker-clinic');
      expect(values).not.toContain('attacker-user');
    });

    it('stores Google tokens encrypted rather than in plaintext', async () => {
      harness.prisma.$queryRaw.mockResolvedValue(storedState('OWNER'));
      grantGoogleTokens();

      await harness.get(`${CALLBACK}?code=abc&state=state-123`);

      const serialized = JSON.stringify(insertValuesFor('google_calendar_integrations'));
      expect(serialized).not.toContain('google-access-token');
      expect(serialized).not.toContain('google-refresh-token');
    });

    it('reports an error when Google withholds the refresh token', async () => {
      harness.prisma.$queryRaw.mockResolvedValue(storedState('OWNER'));
      fetchSpy.mockResolvedValue(jsonResponse({ access_token: 'only-access' }));

      const res = await harness.get(`${CALLBACK}?code=abc&state=state-123`);

      const url = redirectTarget(res.headers.location);
      expect(url.pathname).toBe(OWNER_PATH);
      expect(url.searchParams.get('googleCalendar')).toBe('error');
      expect(harness.prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('sends an OWNER back to /app/agendamentos when Google reports an error', async () => {
      harness.prisma.$queryRaw.mockResolvedValue(storedState('OWNER'));

      const res = await harness.get(`${CALLBACK}?error=access_denied&state=state-123`);

      const url = redirectTarget(res.headers.location);
      expect(url.pathname).toBe(OWNER_PATH);
      expect(url.searchParams.get('googleCalendar')).toBe('error');
      expect(url.searchParams.get('message')).toBeTruthy();
    });

    it('sends a DENTIST back to /app/agenda when Google reports an error', async () => {
      harness.prisma.$queryRaw.mockResolvedValue(storedState('DENTIST'));

      const res = await harness.get(`${CALLBACK}?error=access_denied&state=state-123`);

      const url = redirectTarget(res.headers.location);
      expect(url.pathname).toBe(DENTIST_PATH);
      expect(url.searchParams.get('googleCalendar')).toBe('error');
    });

    it('does not attempt the exchange when Google reports an error', async () => {
      harness.prisma.$queryRaw.mockResolvedValue(storedState('DENTIST'));

      await harness.get(`${CALLBACK}?error=access_denied&state=state-123`);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(harness.prisma.$executeRaw).not.toHaveBeenCalled();
    });
  });

  // ── Unknown, expired and missing state ─────────────────────────────────────

  describe('state that cannot be resolved', () => {
    it('falls back to the OWNER path for an unknown state rather than failing', async () => {
      harness.prisma.$queryRaw.mockResolvedValue([]);

      const res = await harness.get(`${CALLBACK}?code=abc&state=who-knows`);

      expect(res.status).toBe(302);
      const url = redirectTarget(res.headers.location);
      expect(url.pathname).toBe(OWNER_PATH);
      expect(url.searchParams.get('googleCalendar')).toBe('error');
    });

    it('falls back to the OWNER path when no state is supplied at all', async () => {
      const res = await harness.get(`${CALLBACK}?code=abc`);

      const url = redirectTarget(res.headers.location);
      expect(url.pathname).toBe(OWNER_PATH);
      expect(url.searchParams.get('googleCalendar')).toBe('error');
    });

    it('surfaces the expiry message and writes nothing for an expired state', async () => {
      // resolveCallbackRedirectRole filters on expiry and finds nothing;
      // handleCallback re-reads without the filter and rejects on the date.
      harness.prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(storedState('DENTIST', new Date(Date.now() - 60_000)));

      const res = await harness.get(`${CALLBACK}?code=abc&state=state-123`);

      const url = redirectTarget(res.headers.location);
      expect(url.searchParams.get('googleCalendar')).toBe('error');
      expect(url.searchParams.get('message')).toContain('expirada');
      expect(harness.prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('never escalates: an unresolved state grants no clinic or user', async () => {
      harness.prisma.$queryRaw.mockResolvedValue([]);

      await harness.get(`${CALLBACK}?code=abc&state=forged`);

      // No integration row may be written without a resolved state.
      expect(harness.prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('rejects a callback with a state but no code', async () => {
      harness.prisma.$queryRaw.mockResolvedValue(storedState('OWNER'));

      const res = await harness.get(`${CALLBACK}?state=state-123`);

      const url = redirectTarget(res.headers.location);
      expect(url.searchParams.get('googleCalendar')).toBe('error');
      expect(harness.prisma.$executeRaw).not.toHaveBeenCalled();
    });
  });

  // ── State expiry is enforced in the lookup itself ──────────────────────────

  describe('state lookup', () => {
    it('filters expired states out of the redirect-role lookup', async () => {
      harness.prisma.$queryRaw.mockResolvedValue([]);

      await harness.get(`${CALLBACK}?code=abc&state=state-123`);

      const sql = harness.prisma.$queryRaw.mock.calls[0][0].join('?');
      expect(sql).toContain('google_calendar_oauth_states');
      expect(sql).toContain('expiresAt');
      // Joined to users so the role comes from the account, not the request.
      expect(sql).toContain('users');
    });
  });

  // ── Connect: state is issued, not accepted ─────────────────────────────────

  describe('connect', () => {
    it('issues a fresh state bound to the caller for an OWNER', async () => {
      const token = harness.tokenFor(USERS.ownerA);

      const res = await harness
        .post('/calendar-integrations/google/connect')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(201);
      const url = new URL(res.body.url);
      expect(url.origin + url.pathname).toBe(
        'https://accounts.google.com/o/oauth2/v2/auth',
      );
      expect(url.searchParams.get('state')).toBeTruthy();
      expect(url.searchParams.get('access_type')).toBe('offline');

      // The stored state carries the authenticated caller's clinic and id.
      const insert = harness.prisma.$executeRaw.mock.calls.find(([parts]: any) =>
        parts.join('?').includes('INSERT INTO "google_calendar_oauth_states"'),
      );
      expect(insert.slice(1)).toEqual(
        expect.arrayContaining([USERS.ownerA.clinicId, USERS.ownerA.id]),
      );
    });

    it('binds a DENTIST state to the dentist, not the clinic owner', async () => {
      const token = harness.tokenFor(USERS.dentistA);

      await harness
        .post('/calendar-integrations/google/connect')
        .set('Authorization', `Bearer ${token}`);

      const insert = harness.prisma.$executeRaw.mock.calls.find(([parts]: any) =>
        parts.join('?').includes('INSERT INTO "google_calendar_oauth_states"'),
      );
      expect(insert.slice(1)).toEqual(
        expect.arrayContaining([USERS.dentistA.clinicId, USERS.dentistA.id]),
      );
    });

    it('clears the caller’s previous states so only the newest is usable', async () => {
      const token = harness.tokenFor(USERS.dentistA);

      await harness
        .post('/calendar-integrations/google/connect')
        .set('Authorization', `Bearer ${token}`);

      const cleanup = harness.prisma.$executeRaw.mock.calls.find(([parts]: any) =>
        parts.join('?').includes('DELETE FROM "google_calendar_oauth_states"'),
      );
      expect(cleanup).toBeDefined();
      expect(cleanup.slice(1)).toContain(USERS.dentistA.id);
    });
  });
});
