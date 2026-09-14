jest.mock('../../config/google-calendar.config', () => ({
  googleCalendarConfig: {
    clientId: 'test-google-client-id',
    clientSecret: 'test-google-client-secret',
    redirectUri:
      'http://localhost:3000/api/calendar-integrations/google/callback',
    tokenSecret: 'test-google-token-secret-32-bytes-long',
  },
}));

import { InternalServerErrorException } from '@nestjs/common';

import { CalendarIntegrationsService } from './calendar-integrations.service';

/**
 * Google Calendar OAuth lifecycle and token handling.
 *
 * The role-aware callback redirect has its own regression suite. This one
 * covers everything around it: how a connection is established, how the access
 * token is kept alive, what happens when Google says no, and what is left
 * behind on disconnect.
 *
 * Two properties matter most. Tokens are encrypted at rest — a leaked database
 * row must not grant access to a clinic's calendar — and the clinic and user an
 * integration is written for come from the stored OAuth state, never from the
 * request.
 */

const CLINIC = 'clinic-1';
const USER = 'user-1';

function createPrisma() {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
}

function jsonResponse(
  body: unknown,
  init: { ok?: boolean; status?: number } = {},
) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** A live clinic integration row, as findActiveIntegration returns it. */
function integrationRow(
  service: CalendarIntegrationsService,
  overrides: Record<string, unknown> = {},
) {
  const encrypt = (value: string) =>
    (service as unknown as { encrypt(v: string): string }).encrypt(value);

  return {
    id: 'integration-1',
    clinicId: CLINIC,
    googleCalendarId: 'primary',
    googleCalendarSummary: 'Agenda',
    accessTokenEncrypted: encrypt('current-access-token'),
    refreshTokenEncrypted: encrypt('current-refresh-token'),
    tokenExpiresAt: new Date(Date.now() + 3_600_000),
    connectedAt: new Date('2026-06-01T00:00:00.000Z'),
    lastSyncedAt: null,
    ...overrides,
  };
}

describe('CalendarIntegrationsService — OAuth lifecycle', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let service: CalendarIntegrationsService;
  let fetchSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    prisma = createPrisma();
    service = new CalendarIntegrationsService(prisma as never);
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('unexpected network call'));
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** SQL text of the nth $executeRaw call. */
  const executedSql = (index: number) =>
    (prisma.$executeRaw.mock.calls[index][0] as string[]).join('?');

  const allExecutedSql = () =>
    prisma.$executeRaw.mock.calls.map(([parts]) =>
      (parts as string[]).join('?'),
    );

  /**
   * Answers only the integration lookup, so the appointment query that follows
   * it returns an empty list rather than the integration row again.
   */
  function onlyIntegration(row: Record<string, unknown>) {
    prisma.$queryRaw.mockImplementation((parts: unknown) => {
      const sql = (parts as string[]).join('?');
      return Promise.resolve(
        sql.includes('FROM "google_calendar_integrations"') ? [row] : [],
      );
    });
  }

  // ── Connect: issuing state ─────────────────────────────────────────────────

  describe('createConnectUrl (OWNER)', () => {
    it('returns a Google consent URL carrying the issued state', async () => {
      const { url } = await service.createConnectUrl(CLINIC, USER);
      const parsed = new URL(url);

      expect(parsed.origin + parsed.pathname).toBe(
        'https://accounts.google.com/o/oauth2/v2/auth',
      );
      expect(parsed.searchParams.get('client_id')).toBe(
        'test-google-client-id',
      );
      expect(parsed.searchParams.get('state')).toMatch(/[0-9a-f-]{36}/);
    });

    it('asks for offline access and forced consent so a refresh token is returned', async () => {
      // Without prompt=consent Google omits the refresh token on reconnect,
      // and the integration silently dies when the access token expires.
      const { url } = await service.createConnectUrl(CLINIC, USER);
      const parsed = new URL(url);

      expect(parsed.searchParams.get('access_type')).toBe('offline');
      expect(parsed.searchParams.get('prompt')).toBe('consent');
    });

    it('requests only the calendar scopes it needs', async () => {
      const { url } = await service.createConnectUrl(CLINIC, USER);
      const scopes = new URL(url).searchParams.get('scope')!.split(' ');

      expect(scopes).toEqual([
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      ]);
    });

    it('clears the clinic’s previous states and any that expired', async () => {
      await service.createConnectUrl(CLINIC, USER);

      expect(executedSql(0)).toContain(
        'DELETE FROM "google_calendar_oauth_states"',
      );
      expect(executedSql(0)).toContain('"expiresAt" < NOW()');
      expect(prisma.$executeRaw.mock.calls[0].slice(1)).toContain(CLINIC);
    });

    it('stores the state against the clinic and the user who asked', async () => {
      await service.createConnectUrl(CLINIC, USER);

      expect(executedSql(1)).toContain(
        'INSERT INTO "google_calendar_oauth_states"',
      );
      expect(prisma.$executeRaw.mock.calls[1].slice(1)).toEqual(
        expect.arrayContaining([CLINIC, USER]),
      );
    });

    it('gives the state a bounded lifetime', async () => {
      const before = Date.now();
      await service.createConnectUrl(CLINIC, USER);

      const expiresAt = prisma.$executeRaw.mock.calls[1]
        .slice(1)
        .find((value): value is Date => value instanceof Date)!;
      const minutes = (expiresAt.getTime() - before) / 60_000;
      expect(minutes).toBeGreaterThan(0);
      expect(minutes).toBeLessThanOrEqual(10);
    });

    it('issues a different state each time', async () => {
      const first = new URL((await service.createConnectUrl(CLINIC, USER)).url);
      const second = new URL(
        (await service.createConnectUrl(CLINIC, USER)).url,
      );

      expect(first.searchParams.get('state')).not.toBe(
        second.searchParams.get('state'),
      );
    });
  });

  describe('createDentistConnectUrl', () => {
    it('clears the dentist’s own previous states rather than the whole clinic’s', async () => {
      // A dentist reconnecting must not invalidate a colleague's in-flight
      // consent, so the cleanup is scoped to the user.
      await service.createDentistConnectUrl(USER, CLINIC);

      expect(executedSql(0)).toContain('"userId"');
      expect(prisma.$executeRaw.mock.calls[0].slice(1)).toContain(USER);
    });

    it('stores the state against both the dentist and their clinic', async () => {
      await service.createDentistConnectUrl(USER, CLINIC);

      expect(prisma.$executeRaw.mock.calls[1].slice(1)).toEqual(
        expect.arrayContaining([CLINIC, USER]),
      );
    });
  });

  // ── Missing configuration ──────────────────────────────────────────────────

  describe('missing provider configuration', () => {
    it.each([
      ['createConnectUrl', () => service.createConnectUrl(CLINIC, USER)],
      [
        'createDentistConnectUrl',
        () => service.createDentistConnectUrl(USER, CLINIC),
      ],
      ['sync', () => service.sync(CLINIC)],
      ['disconnect', () => service.disconnect(CLINIC)],
      ['handleCallback', () => service.handleCallback('code', 'state')],
    ])('refuses %s when Google is not configured', async (_name, call) => {
      jest
        .spyOn(service as unknown as { assertConfig(): void }, 'assertConfig')
        .mockImplementation(() => {
          throw new InternalServerErrorException(
            'Configuração do Google Agenda incompleta no backend.',
          );
        });

      await expect(call()).rejects.toThrow(InternalServerErrorException);
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });
  });

  // ── Callback: state validation ─────────────────────────────────────────────

  describe('handleCallback state validation', () => {
    it.each([
      ['no code', undefined, 'state-1'],
      ['no state', 'code-1', undefined],
      ['neither', undefined, undefined],
    ])('rejects a callback with %s', async (_name, code, state) => {
      await expect(service.handleCallback(code, state)).rejects.toThrow(
        /Retorno do Google Agenda incompleto/,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects a state that does not exist', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      await expect(service.handleCallback('code-1', 'unknown')).rejects.toThrow(
        /expirada/,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects a state that has expired', async () => {
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 'state-1',
          clinicId: CLINIC,
          userId: USER,
          userRole: 'OWNER',
          expiresAt: new Date(Date.now() - 1000),
        },
      ]);

      await expect(service.handleCallback('code-1', 'state-1')).rejects.toThrow(
        /expirada/,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('writes nothing when the state is rejected', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      await service.handleCallback('code-1', 'unknown').catch(() => undefined);

      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });
  });

  describe('resolveCallbackRedirectRole', () => {
    it('returns null without querying when no state is supplied', async () => {
      await expect(
        service.resolveCallbackRedirectRole(undefined),
      ).resolves.toBeNull();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('excludes expired states from the lookup', async () => {
      await service.resolveCallbackRedirectRole('state-1');

      const sql = (prisma.$queryRaw.mock.calls[0][0] as string[]).join('?');
      expect(sql).toContain('"expiresAt" >= NOW()');
    });

    it('treats any non-DENTIST role as an owner redirect', async () => {
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 's',
          clinicId: CLINIC,
          userId: USER,
          userRole: 'ASSISTANT',
          expiresAt: new Date(),
        },
      ]);

      await expect(service.resolveCallbackRedirectRole('s')).resolves.toBe(
        'OWNER',
      );
    });
  });

  // ── Callback: token exchange ───────────────────────────────────────────────

  describe('handleCallback token exchange', () => {
    function liveState(role: 'OWNER' | 'DENTIST' = 'OWNER') {
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 'state-1',
          clinicId: 'clinic-from-state',
          userId: 'user-from-state',
          userRole: role,
          expiresAt: new Date(Date.now() + 60_000),
        },
      ]);
    }

    function googleGrants(token: Record<string, unknown>) {
      fetchSpy.mockImplementation((input: unknown) => {
        const url = String(input);
        if (url.includes('oauth2.googleapis.com/token')) {
          return Promise.resolve(jsonResponse(token));
        }
        if (url.includes('googleapis.com/calendar')) {
          return Promise.resolve(
            jsonResponse({ id: 'primary', summary: 'Minha Agenda' }),
          );
        }
        return Promise.reject(new Error(`unexpected ${url}`));
      });
    }

    const fullGrant = {
      access_token: 'granted-access',
      refresh_token: 'granted-refresh',
      expires_in: 3600,
    };

    it('rejects when Google returns no refresh token', async () => {
      liveState();
      googleGrants({ access_token: 'only-access' });

      await expect(service.handleCallback('code-1', 'state-1')).rejects.toThrow(
        /autorização completa/,
      );
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('rejects when Google returns no access token', async () => {
      liveState();
      googleGrants({ refresh_token: 'only-refresh' });

      await expect(service.handleCallback('code-1', 'state-1')).rejects.toThrow(
        /autorização completa/,
      );
    });

    it('rejects when the token endpoint fails', async () => {
      liveState();
      fetchSpy.mockResolvedValue(jsonResponse({}, { ok: false, status: 400 }));

      await expect(service.handleCallback('code-1', 'state-1')).rejects.toThrow(
        /autenticar no Google Agenda/,
      );
    });

    it('rejects when the calendar lookup fails', async () => {
      liveState();
      fetchSpy.mockImplementation((input: unknown) =>
        String(input).includes('token')
          ? Promise.resolve(jsonResponse(fullGrant))
          : Promise.resolve(jsonResponse({}, { ok: false, status: 403 })),
      );

      await expect(service.handleCallback('code-1', 'state-1')).rejects.toThrow(
        /calendário principal/,
      );
    });

    it('stores the tokens encrypted, never in plaintext', async () => {
      liveState();
      googleGrants(fullGrant);

      await service.handleCallback('code-1', 'state-1');

      const serialized = JSON.stringify(prisma.$executeRaw.mock.calls);
      expect(serialized).not.toContain('granted-access');
      expect(serialized).not.toContain('granted-refresh');
    });

    it('writes the clinic integration for an owner state', async () => {
      liveState('OWNER');
      googleGrants(fullGrant);

      await service.handleCallback('code-1', 'state-1');

      expect(
        allExecutedSql().some((sql) =>
          sql.includes('INSERT INTO "google_calendar_integrations"'),
        ),
      ).toBe(true);
    });

    it('writes the per-user integration for a dentist state', async () => {
      liveState('DENTIST');
      googleGrants(fullGrant);

      await service.handleCallback('code-1', 'state-1');

      expect(
        allExecutedSql().some((sql) =>
          sql.includes('INSERT INTO "user_google_calendar_integrations"'),
        ),
      ).toBe(true);
    });

    it('reconnecting replaces the existing integration rather than duplicating it', async () => {
      liveState('OWNER');
      googleGrants(fullGrant);

      await service.handleCallback('code-1', 'state-1');

      const insert = allExecutedSql().find((sql) =>
        sql.includes('INSERT INTO "google_calendar_integrations"'),
      )!;
      expect(insert).toContain('ON CONFLICT ("clinicId") DO UPDATE');
      // A previous disconnect must not survive the reconnect.
      expect(insert).toContain('"disconnectedAt"');
    });

    it('consumes the state exactly once', async () => {
      liveState('OWNER');
      googleGrants(fullGrant);

      await service.handleCallback('code-1', 'state-1');

      const deletes = allExecutedSql().filter((sql) =>
        sql.includes('DELETE FROM "google_calendar_oauth_states"'),
      );
      expect(deletes).toHaveLength(1);
    });

    it('defaults the calendar id when Google names none', async () => {
      liveState('OWNER');
      fetchSpy.mockImplementation((input: unknown) =>
        String(input).includes('token')
          ? Promise.resolve(jsonResponse(fullGrant))
          : Promise.resolve(jsonResponse({})),
      );

      await service.handleCallback('code-1', 'state-1');

      const insert = prisma.$executeRaw.mock.calls.find(([parts]) =>
        (parts as string[])
          .join('?')
          .includes('INSERT INTO "google_calendar_integrations"'),
      )!;
      expect(insert.slice(1)).toContain('primary');
    });

    it('keeps the connection when the initial sync fails', async () => {
      // The integration is already written; a sync hiccup must not undo it.
      liveState('OWNER');
      googleGrants(fullGrant);
      prisma.$queryRaw.mockImplementation((parts: unknown) => {
        const sql = (parts as string[]).join('?');
        if (sql.includes('google_calendar_oauth_states')) {
          return Promise.resolve([
            {
              id: 'state-1',
              clinicId: 'clinic-from-state',
              userId: 'user-from-state',
              userRole: 'OWNER',
              expiresAt: new Date(Date.now() + 60_000),
            },
          ]);
        }
        return Promise.reject(new Error('sync lookup exploded'));
      });

      await expect(
        service.handleCallback('code-1', 'state-1'),
      ).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  // ── Access-token refresh ───────────────────────────────────────────────────

  describe('access token refresh', () => {
    it('reuses a token that is still comfortably valid', async () => {
      onlyIntegration(integrationRow(service));

      await service.sync(CLINIC);

      // No refresh round-trip for a token with an hour left on it.
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('refreshes a token that is about to expire', async () => {
      onlyIntegration(
        integrationRow(service, {
          tokenExpiresAt: new Date(Date.now() + 30_000),
        }),
      );
      fetchSpy.mockResolvedValue(
        jsonResponse({ access_token: 'refreshed-access', expires_in: 3600 }),
      );

      await service.sync(CLINIC);

      expect(String(fetchSpy.mock.calls[0][0])).toContain(
        'oauth2.googleapis.com/token',
      );
    });

    it('persists the refreshed token encrypted', async () => {
      onlyIntegration(
        integrationRow(service, {
          tokenExpiresAt: new Date(Date.now() - 1000),
        }),
      );
      fetchSpy.mockResolvedValue(
        jsonResponse({ access_token: 'refreshed-access', expires_in: 3600 }),
      );

      await service.sync(CLINIC);

      const serialized = JSON.stringify(prisma.$executeRaw.mock.calls);
      expect(serialized).not.toContain('refreshed-access');
      expect(
        allExecutedSql().some((sql) => sql.includes('"accessTokenEncrypted"')),
      ).toBe(true);
    });

    it('reports a refresh that returns no token', async () => {
      onlyIntegration(
        integrationRow(service, {
          tokenExpiresAt: new Date(Date.now() - 1000),
        }),
      );
      fetchSpy.mockResolvedValue(jsonResponse({ expires_in: 3600 }));

      await expect(service.sync(CLINIC)).rejects.toThrow(/renovar o acesso/);
    });
  });

  // ── Sync ───────────────────────────────────────────────────────────────────

  describe('sync', () => {
    it('refuses when the clinic has no active integration', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      await expect(service.sync(CLINIC)).rejects.toThrow(/não está conectado/);
    });

    it('reports nothing synced when there is nothing to sync', async () => {
      onlyIntegration(integrationRow(service));

      await expect(service.sync(CLINIC)).resolves.toEqual({
        synced: 0,
        failed: 0,
      });
    });

    it('stamps the last sync time even when nothing changed', async () => {
      onlyIntegration(integrationRow(service));

      await service.sync(CLINIC);

      expect(
        allExecutedSql().some((sql) => sql.includes('"lastSyncedAt"')),
      ).toBe(true);
    });
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────

  describe('disconnect', () => {
    it('reports a disconnected state without touching Google when nothing is connected', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      await expect(service.disconnect(CLINIC)).resolves.toEqual({
        connected: false,
        calendarSummary: null,
        connectedAt: null,
        lastSyncedAt: null,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('revokes the refresh token at Google and marks the row disconnected', async () => {
      prisma.$queryRaw.mockImplementation((parts: unknown) => {
        const sql = (parts as string[]).join('?');
        if (sql.includes('FROM "google_calendar_integrations"')) {
          return Promise.resolve([integrationRow(service)]);
        }
        return Promise.resolve([]);
      });
      fetchSpy.mockResolvedValue(jsonResponse({}));

      await service.disconnect(CLINIC);

      expect(
        fetchSpy.mock.calls.some(([url]) => String(url).includes('revoke')),
      ).toBe(true);
      expect(
        allExecutedSql().some((sql) =>
          sql.includes('"disconnectedAt" = NOW()'),
        ),
      ).toBe(true);
    });
  });

  // ── Status ─────────────────────────────────────────────────────────────────

  describe('status', () => {
    it('reports not connected when no integration exists', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      await expect(service.getStatus(CLINIC)).resolves.toEqual({
        connected: false,
        calendarSummary: null,
        connectedAt: null,
        lastSyncedAt: null,
      });
    });

    it('reports the calendar summary when connected', async () => {
      prisma.$queryRaw.mockResolvedValue([integrationRow(service)]);

      await expect(service.getStatus(CLINIC)).resolves.toMatchObject({
        connected: true,
        calendarSummary: 'Agenda',
      });
    });

    it('excludes a disconnected integration from the lookup', async () => {
      await service.getStatus(CLINIC);

      const sql = (prisma.$queryRaw.mock.calls[0][0] as string[]).join('?');
      expect(sql).toContain('"disconnectedAt" IS NULL');
    });
  });

  // ── Encryption ─────────────────────────────────────────────────────────────

  describe('token encryption', () => {
    const cipher = () =>
      service as unknown as {
        encrypt(value: string): string;
        decrypt(value: string): string;
      };

    it('round-trips a token', () => {
      const encrypted = cipher().encrypt('a-google-token');

      expect(encrypted).not.toContain('a-google-token');
      expect(cipher().decrypt(encrypted)).toBe('a-google-token');
    });

    it('produces a different ciphertext each time for the same input', () => {
      // A fresh IV per encryption; identical ciphertexts would leak that two
      // clinics hold the same token.
      const first = cipher().encrypt('same-token');
      const second = cipher().encrypt('same-token');

      expect(first).not.toBe(second);
      expect(cipher().decrypt(first)).toBe(cipher().decrypt(second));
    });

    it('refuses to decrypt a tampered ciphertext', () => {
      // AES-GCM authenticates, so a modified payload fails rather than
      // returning plausible-looking garbage.
      const encrypted = cipher().encrypt('a-google-token');
      const [iv, tag, payload] = encrypted.split(':');
      const flipped = Buffer.from(payload, 'base64');
      flipped[0] ^= 0xff;

      expect(() =>
        cipher().decrypt(`${iv}:${tag}:${flipped.toString('base64')}`),
      ).toThrow();
    });

    it('handles an empty value without corrupting it', () => {
      expect(cipher().decrypt(cipher().encrypt(''))).toBe('');
    });
  });
});
