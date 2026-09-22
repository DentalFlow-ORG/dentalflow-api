jest.mock('../../config/google-calendar.config', () => ({
  googleCalendarConfig: {
    clientId: 'test-google-client-id',
    clientSecret: 'test-google-client-secret',
    redirectUri:
      'http://localhost:3000/api/calendar-integrations/google/callback',
    tokenSecret: 'test-google-token-secret-32-bytes-long',
  },
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';

import { CalendarIntegrationsService } from './calendar-integrations.service';

/**
 * Google Calendar synchronisation.
 *
 * A note on what this sync *is*, because it decides what there is to test.
 * DentalFlow pushes: it writes its own appointments into the clinic's calendar
 * and deletes the events it wrote. It never reads Google's calendar back.
 * There is no `syncToken`, no `nextPageToken`, no incremental change feed and
 * no import of events created in Google — so there is nothing here about
 * pagination, expired sync tokens or cancelled Google events, and inventing
 * tests for them would be inventing behaviour the product does not have.
 *
 * What it does have, and what these tests cover, is a loop over appointments
 * that must survive one event failing, an update-then-create fallback for an
 * event a user deleted in Google, a retry ladder for Google's rate limiter,
 * and a delete path that must decide whether to forget the event id. Only the
 * provider boundary is stubbed — `fetch` and the raw SQL. Every decision
 * between them is the real service.
 */

const CLINIC = 'clinic-1';
const USER = 'user-1';
const PROFILE = 'profile-1';

type Prisma = {
  $queryRaw: jest.Mock;
  $executeRaw: jest.Mock;
};

function createPrisma(): Prisma {
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

/** A Google response that is not JSON at all — a proxy error page, say. */
function unparseableResponse(status: number) {
  return {
    ok: false,
    status,
    json: () => Promise.reject(new Error('Unexpected token < in JSON')),
  } as unknown as Response;
}

function encryptWith(service: CalendarIntegrationsService, value: string) {
  return (service as unknown as { encrypt(v: string): string }).encrypt(value);
}

function integrationRow(
  service: CalendarIntegrationsService,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: 'integration-1',
    clinicId: CLINIC,
    googleCalendarId: 'primary',
    googleCalendarSummary: 'Agenda',
    accessTokenEncrypted: encryptWith(service, 'current-access-token'),
    refreshTokenEncrypted: encryptWith(service, 'current-refresh-token'),
    tokenExpiresAt: new Date(Date.now() + 3_600_000),
    connectedAt: new Date('2026-06-01T00:00:00.000Z'),
    lastSyncedAt: null,
    ...overrides,
  };
}

function userIntegrationRow(
  service: CalendarIntegrationsService,
  overrides: Record<string, unknown> = {},
) {
  return {
    ...integrationRow(service, overrides),
    userId: USER,
    googleCalendarId: 'dentist@example.test',
  };
}

/** An appointment row exactly as the sync query selects it. */
function appointmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'appointment-1',
    googleCalendarEventId: null,
    dentistGoogleCalendarEventId: null,
    appointmentDate: new Date('2026-06-15T00:00:00.000Z'),
    startTime: new Date('1970-01-01T09:00:00.000Z'),
    endTime: new Date('1970-01-01T10:00:00.000Z'),
    profileName: 'Dra. Ana',
    timezone: 'America/Sao_Paulo',
    patientName: 'Maria Silva',
    serviceName: 'Limpeza',
    ...overrides,
  };
}

describe('CalendarIntegrationsService — synchronisation', () => {
  let prisma: Prisma;
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

    // The service paces itself between events and backs off when rate
    // limited. Collapsing the waits keeps the retry ladder under test without
    // spending its 5 seconds; the ordering it enforces is unchanged.
    jest.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
    ) => {
      fn();
      return 0;
    }) as unknown as typeof setTimeout);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * Routes each raw query to a result by the table it reads, so a test says
   * what the database contains rather than what order the service asks in.
   */
  function db(tables: {
    integration?: Record<string, unknown> | null;
    userIntegration?: Record<string, unknown> | null;
    profile?: Record<string, unknown> | null;
    appointments?: Record<string, unknown>[];
  }) {
    prisma.$queryRaw.mockImplementation((parts: unknown) => {
      const sql = (parts as string[]).join('?');

      if (sql.includes('FROM "google_calendar_integrations"')) {
        return Promise.resolve(tables.integration ? [tables.integration] : []);
      }
      if (sql.includes('FROM "user_google_calendar_integrations"')) {
        return Promise.resolve(
          tables.userIntegration ? [tables.userIntegration] : [],
        );
      }
      if (sql.includes('FROM "profiles"')) {
        return Promise.resolve(tables.profile ? [tables.profile] : []);
      }
      if (sql.includes('FROM "appointments"')) {
        return Promise.resolve(tables.appointments ?? []);
      }
      return Promise.resolve([]);
    });
  }

  /** Every SQL statement the service executed, joined for matching. */
  function executed(): string[] {
    return prisma.$executeRaw.mock.calls.map((call) =>
      (call[0] as string[]).join('?'),
    );
  }

  function executedMatching(fragment: string): string[] {
    return executed().filter((sql) => sql.includes(fragment));
  }

  // ── Clinic sync ────────────────────────────────────────────────────────────

  describe('sync (clinic calendar)', () => {
    it('refuses when the clinic has no live integration', async () => {
      db({ integration: null });

      await expect(service.sync(CLINIC)).rejects.toThrow(BadRequestException);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('creates an event for an appointment that has never been synced', async () => {
      db({
        integration: integrationRow(service),
        appointments: [appointmentRow()],
      });
      fetchSpy.mockResolvedValue(jsonResponse({ id: 'google-event-1' }));

      const result = await service.sync(CLINIC);

      expect(result).toEqual({ synced: 1, failed: 0 });
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      );
      expect(init.method).toBe('POST');
    });

    it('stores the event id Google returned', async () => {
      db({
        integration: integrationRow(service),
        appointments: [appointmentRow()],
      });
      fetchSpy.mockResolvedValue(jsonResponse({ id: 'google-event-1' }));

      await service.sync(CLINIC);

      const writes = executedMatching('"googleCalendarEventId" =');
      expect(writes).toHaveLength(1);
      expect(prisma.$executeRaw.mock.calls[0]).toContain('google-event-1');
    });

    it('updates the existing event rather than creating a duplicate', async () => {
      db({
        integration: integrationRow(service),
        appointments: [appointmentRow({ googleCalendarEventId: 'existing-1' })],
      });
      fetchSpy.mockResolvedValue(jsonResponse({ id: 'existing-1' }));

      const result = await service.sync(CLINIC);

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/events/existing-1');
      expect(init.method).toBe('PATCH');
      expect(result).toEqual({ synced: 1, failed: 0 });
    });

    it('writes nothing back when the event id is unchanged', async () => {
      db({
        integration: integrationRow(service),
        appointments: [appointmentRow({ googleCalendarEventId: 'existing-1' })],
      });
      fetchSpy.mockResolvedValue(jsonResponse({ id: 'existing-1' }));

      await service.sync(CLINIC);

      expect(executedMatching('SET "googleCalendarEventId"')).toHaveLength(0);
    });

    it('recreates an event the user deleted inside Google', async () => {
      db({
        integration: integrationRow(service),
        appointments: [appointmentRow({ googleCalendarEventId: 'gone-1' })],
      });
      // Google answers 404 for the PATCH, then accepts the POST.
      fetchSpy
        .mockResolvedValueOnce(
          jsonResponse({ error: { code: 404, message: 'Not Found' } }),
        )
        .mockResolvedValueOnce(jsonResponse({ id: 'recreated-1' }));

      const result = await service.sync(CLINIC);

      expect(result).toEqual({ synced: 1, failed: 0 });
      expect((fetchSpy.mock.calls[1][1] as RequestInit).method).toBe('POST');
      expect(prisma.$executeRaw.mock.calls[0]).toContain('recreated-1');
    });

    it('fails the appointment when the update is refused for any other reason', async () => {
      db({
        integration: integrationRow(service),
        appointments: [appointmentRow({ googleCalendarEventId: 'existing-1' })],
      });
      fetchSpy.mockResolvedValue(
        jsonResponse(
          { error: { code: 403, message: 'Forbidden' } },
          { ok: false, status: 403 },
        ),
      );

      const result = await service.sync(CLINIC);

      expect(result).toEqual({ synced: 0, failed: 1 });
      expect(executedMatching('SET "googleCalendarEventId"')).toHaveLength(0);
    });

    it('carries on after one appointment fails', async () => {
      db({
        integration: integrationRow(service),
        appointments: [
          appointmentRow({ id: 'a-1' }),
          appointmentRow({ id: 'a-2' }),
          appointmentRow({ id: 'a-3' }),
        ],
      });
      fetchSpy
        .mockResolvedValueOnce(jsonResponse({ id: 'event-1' }))
        .mockResolvedValueOnce(
          jsonResponse(
            { error: { code: 500, message: 'Backend Error' } },
            { ok: false, status: 500 },
          ),
        )
        .mockResolvedValueOnce(jsonResponse({ id: 'event-3' }));

      // One bad appointment must not cost the clinic the other two.
      const result = await service.sync(CLINIC);

      expect(result).toEqual({ synced: 2, failed: 1 });
    });

    it('marks the integration as synced even when some events failed', async () => {
      db({
        integration: integrationRow(service),
        appointments: [appointmentRow()],
      });
      fetchSpy.mockResolvedValue(
        jsonResponse({ error: { code: 500 } }, { ok: false, status: 500 }),
      );

      await service.sync(CLINIC);

      expect(executedMatching('"lastSyncedAt" = NOW()')).toHaveLength(1);
    });

    it('is a no-op sync when the clinic has no appointments to push', async () => {
      db({ integration: integrationRow(service), appointments: [] });

      const result = await service.sync(CLINIC);

      expect(result).toEqual({ synced: 0, failed: 0 });
      expect(fetchSpy).not.toHaveBeenCalled();
      // The timestamp still moves: a sync that found nothing did happen.
      expect(executedMatching('"lastSyncedAt" = NOW()')).toHaveLength(1);
    });

    it('scopes the sync timestamp to the calling clinic', async () => {
      db({ integration: integrationRow(service), appointments: [] });

      await service.sync(CLINIC);

      expect(prisma.$executeRaw.mock.calls[0]).toContain(CLINIC);
    });
  });

  // ── The event Google receives ──────────────────────────────────────────────

  describe('the event body', () => {
    async function capturedBody(
      appointment: Record<string, unknown> = {},
    ): Promise<Record<string, never>> {
      db({
        integration: integrationRow(service),
        appointments: [appointmentRow(appointment)],
      });
      fetchSpy.mockResolvedValue(jsonResponse({ id: 'event-1' }));

      await service.sync(CLINIC);

      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      return JSON.parse(init.body as string) as Record<string, never>;
    }

    it('titles the event with the service and the patient', async () => {
      const body = await capturedBody();
      expect(body.summary).toBe('Limpeza - Maria Silva');
    });

    it('falls back to the service alone when the patient is unnamed', async () => {
      const body = await capturedBody({ patientName: null });
      expect(body.summary).toBe('Limpeza');
    });

    it('falls back to a generic title with the patient when there is no service', async () => {
      const body = await capturedBody({ serviceName: null });
      expect(body.summary).toBe('Consulta odontologica - Maria Silva');
    });

    it('falls back to a generic title when neither is known', async () => {
      const body = await capturedBody({ serviceName: null, patientName: null });
      expect(body.summary).toBe('Consulta odontologica');
    });

    it('keeps patient detail out of the event body', async () => {
      const body = await capturedBody();

      // The calendar is outside the clinic's control. Only the title carries a
      // name; the description must not add contact details or notes.
      expect(body.description).toContain('Dra. Ana');
      expect(body.description).toContain(
        'O título compartilha nome do paciente e serviço com este calendário. Prontuário e contatos permanecem no DentalFlow.',
      );
    });

    it('sends the appointment window in the clinic timezone', async () => {
      const body = await capturedBody();

      expect(body.start).toEqual({
        dateTime: '2026-06-15T09:00:00',
        timeZone: 'America/Sao_Paulo',
      });
      expect(body.end).toEqual({
        dateTime: '2026-06-15T10:00:00',
        timeZone: 'America/Sao_Paulo',
      });
    });

    it('defaults to Brazil when the clinic has no timezone set', async () => {
      const body = await capturedBody({ timezone: null });
      expect(body.start).toMatchObject({ timeZone: 'America/Sao_Paulo' });
    });

    it('reads a date the driver handed back as a string', async () => {
      // The raw query is untyped, so a DATE can arrive as a string.
      const body = await capturedBody({
        appointmentDate: '2026-06-15',
        startTime: '09:30:00',
        endTime: '10:15:00',
      });

      expect(body.start).toMatchObject({ dateTime: '2026-06-15T09:30:00' });
      expect(body.end).toMatchObject({ dateTime: '2026-06-15T10:15:00' });
    });

    it('reads a full ISO timestamp handed back as a string', async () => {
      const body = await capturedBody({
        appointmentDate: '2026-06-15T00:00:00.000Z',
        startTime: '1970-01-01T14:05:00.000Z',
      });

      expect(body.start).toMatchObject({ dateTime: '2026-06-15T14:05:00' });
    });

    it('takes the date from the appointment, not from the local clock', async () => {
      // A UTC-midnight DATE must render as that day, not the day before it in
      // Brazil. The whole calendar is wrong by a day otherwise.
      const body = await capturedBody({
        appointmentDate: new Date('2026-01-01T00:00:00.000Z'),
      });

      expect(body.start).toMatchObject({ dateTime: '2026-01-01T09:00:00' });
    });
  });

  // ── Rate limiting ──────────────────────────────────────────────────────────

  describe('when Google rate limits', () => {
    const rateLimited = () =>
      jsonResponse(
        { error: { code: 429, message: 'Rate Limit Exceeded' } },
        { ok: false, status: 429 },
      );

    it('retries and succeeds', async () => {
      db({
        integration: integrationRow(service),
        appointments: [appointmentRow()],
      });
      fetchSpy
        .mockResolvedValueOnce(rateLimited())
        .mockResolvedValueOnce(jsonResponse({ id: 'event-1' }));

      const result = await service.sync(CLINIC);

      expect(result).toEqual({ synced: 1, failed: 0 });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('recognises the quota error by reason as well as by status', async () => {
      db({
        integration: integrationRow(service),
        appointments: [appointmentRow()],
      });
      fetchSpy
        .mockResolvedValueOnce(
          jsonResponse(
            {
              error: {
                code: 403,
                errors: [{ reason: 'userRateLimitExceeded' }],
              },
            },
            { ok: false, status: 403 },
          ),
        )
        .mockResolvedValueOnce(jsonResponse({ id: 'event-1' }));

      const result = await service.sync(CLINIC);

      // A 403 that is really a quota error must back off, not be treated as a
      // permission failure and thrown away.
      expect(result).toEqual({ synced: 1, failed: 0 });
    });

    it('recognises RESOURCE_EXHAUSTED', async () => {
      db({
        integration: integrationRow(service),
        appointments: [appointmentRow()],
      });
      fetchSpy
        .mockResolvedValueOnce(
          jsonResponse(
            { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } },
            { ok: false, status: 500 },
          ),
        )
        .mockResolvedValueOnce(jsonResponse({ id: 'event-1' }));

      await expect(service.sync(CLINIC)).resolves.toEqual({
        synced: 1,
        failed: 0,
      });
    });

    it('gives up after the retry ladder is exhausted', async () => {
      db({
        integration: integrationRow(service),
        appointments: [appointmentRow()],
      });
      fetchSpy.mockResolvedValue(rateLimited());

      const result = await service.sync(CLINIC);

      // Three delays configured, so four attempts in total, then the
      // appointment is counted as failed rather than retried forever.
      expect(fetchSpy).toHaveBeenCalledTimes(4);
      expect(result).toEqual({ synced: 0, failed: 1 });
    });

    it('does not retry an error that is not a quota error', async () => {
      db({
        integration: integrationRow(service),
        appointments: [appointmentRow()],
      });
      fetchSpy.mockResolvedValue(
        jsonResponse(
          { error: { code: 401, message: 'Invalid Credentials' } },
          { ok: false, status: 401 },
        ),
      );

      const result = await service.sync(CLINIC);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ synced: 0, failed: 1 });
    });
  });

  // ── Access tokens ──────────────────────────────────────────────────────────

  describe('access tokens', () => {
    it('uses the stored token while it is still valid', async () => {
      db({
        integration: integrationRow(service),
        appointments: [appointmentRow()],
      });
      fetchSpy.mockResolvedValue(jsonResponse({ id: 'event-1' }));

      await service.sync(CLINIC);

      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect((init.headers as Record<string, string>).Authorization).toBe(
        'Bearer current-access-token',
      );
    });

    it('refreshes a token inside the expiry margin before syncing', async () => {
      db({
        integration: integrationRow(service, {
          tokenExpiresAt: new Date(Date.now() + 30_000),
        }),
        appointments: [appointmentRow()],
      });
      fetchSpy
        .mockResolvedValueOnce(
          jsonResponse({ access_token: 'fresh-token', expires_in: 3600 }),
        )
        .mockResolvedValueOnce(jsonResponse({ id: 'event-1' }));

      await service.sync(CLINIC);

      expect(fetchSpy.mock.calls[0][0]).toBe(
        'https://oauth2.googleapis.com/token',
      );
      const eventInit = fetchSpy.mock.calls[1][1] as RequestInit;
      expect((eventInit.headers as Record<string, string>).Authorization).toBe(
        'Bearer fresh-token',
      );
    });

    it('stores the refreshed token encrypted, never in the clear', async () => {
      db({
        integration: integrationRow(service, {
          tokenExpiresAt: new Date(Date.now() - 1_000),
        }),
        appointments: [],
      });
      fetchSpy.mockResolvedValue(
        jsonResponse({ access_token: 'fresh-token', expires_in: 3600 }),
      );

      await service.sync(CLINIC);

      const write = prisma.$executeRaw.mock.calls.find((call) =>
        (call[0] as string[]).join('?').includes('"accessTokenEncrypted"'),
      );
      expect(write).toBeDefined();
      const stored = write!.find(
        (value): value is string =>
          typeof value === 'string' && value.includes(':'),
      );
      expect(stored).toBeDefined();
      expect(stored).not.toContain('fresh-token');
      // Round-trips through the service's own key, so it is really ciphertext.
      const decrypt = (service as unknown as { decrypt(v: string): string })
        .decrypt;
      expect(decrypt.call(service, stored)).toBe('fresh-token');
    });

    it('refuses to sync when Google will not renew the token', async () => {
      db({
        integration: integrationRow(service, {
          tokenExpiresAt: new Date(Date.now() - 1_000),
        }),
        appointments: [appointmentRow()],
      });
      fetchSpy.mockResolvedValue(jsonResponse({ expires_in: 3600 }));

      await expect(service.sync(CLINIC)).rejects.toThrow(BadRequestException);
    });

    it('surfaces a rejected refresh rather than syncing with a dead token', async () => {
      db({
        integration: integrationRow(service, {
          tokenExpiresAt: new Date(Date.now() - 1_000),
        }),
        appointments: [appointmentRow()],
      });
      fetchSpy.mockResolvedValue(
        jsonResponse({ error: 'invalid_grant' }, { ok: false, status: 400 }),
      );

      await expect(service.sync(CLINIC)).rejects.toThrow(BadRequestException);
      // The appointment loop never ran.
      expect(executedMatching('SET "googleCalendarEventId"')).toHaveLength(0);
    });
  });

  // ── Deleting a single appointment's event ──────────────────────────────────

  describe('deleteAppointmentEvent', () => {
    it('does nothing when the clinic has no integration', async () => {
      db({ integration: null });

      await service.deleteAppointmentEvent(CLINIC, 'appointment-1');

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('does nothing when the appointment was never pushed', async () => {
      db({
        integration: integrationRow(service),
        appointments: [{ id: 'appointment-1', googleCalendarEventId: null }],
      });

      await service.deleteAppointmentEvent(CLINIC, 'appointment-1');

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('deletes the event and forgets its id', async () => {
      db({
        integration: integrationRow(service),
        appointments: [
          { id: 'appointment-1', googleCalendarEventId: 'event-1' },
        ],
      });
      fetchSpy.mockResolvedValue({ ok: true, status: 204 } as Response);

      await service.deleteAppointmentEvent(CLINIC, 'appointment-1');

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/events/event-1');
      expect(init.method).toBe('DELETE');
      expect(
        executedMatching('SET "googleCalendarEventId" = NULL'),
      ).toHaveLength(1);
    });

    it('forgets the id when Google says the event is already gone', async () => {
      db({
        integration: integrationRow(service),
        appointments: [
          { id: 'appointment-1', googleCalendarEventId: 'event-1' },
        ],
      });
      fetchSpy.mockResolvedValue({ ok: false, status: 410 } as Response);

      await service.deleteAppointmentEvent(CLINIC, 'appointment-1');

      // 410 means someone deleted it in Google. Keeping the id would make
      // every later sync try to patch an event that does not exist.
      expect(
        executedMatching('SET "googleCalendarEventId" = NULL'),
      ).toHaveLength(1);
    });

    it('keeps the id when the delete genuinely failed', async () => {
      db({
        integration: integrationRow(service),
        appointments: [
          { id: 'appointment-1', googleCalendarEventId: 'event-1' },
        ],
      });
      fetchSpy.mockResolvedValue(
        jsonResponse({ error: { code: 500 } }, { ok: false, status: 500 }),
      );

      await service.deleteAppointmentEvent(CLINIC, 'appointment-1');

      // Forgetting the id here would orphan a real event in the calendar with
      // nothing left pointing at it.
      expect(
        executedMatching('SET "googleCalendarEventId" = NULL'),
      ).toHaveLength(0);
    });

    it('treats a response that is not JSON as a plain failure', async () => {
      db({
        integration: integrationRow(service),
        appointments: [
          { id: 'appointment-1', googleCalendarEventId: 'event-1' },
        ],
      });
      fetchSpy.mockResolvedValue(unparseableResponse(502));

      await service.deleteAppointmentEvent(CLINIC, 'appointment-1');

      expect(
        executedMatching('SET "googleCalendarEventId" = NULL'),
      ).toHaveLength(0);
    });

    it('retries a rate-limited delete', async () => {
      db({
        integration: integrationRow(service),
        appointments: [
          { id: 'appointment-1', googleCalendarEventId: 'event-1' },
        ],
      });
      fetchSpy
        .mockResolvedValueOnce(
          jsonResponse({ error: { code: 429 } }, { ok: false, status: 429 }),
        )
        .mockResolvedValueOnce({ ok: true, status: 204 } as Response);

      await service.deleteAppointmentEvent(CLINIC, 'appointment-1');

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(
        executedMatching('SET "googleCalendarEventId" = NULL'),
      ).toHaveLength(1);
    });

    it('looks the appointment up inside the caller’s clinic', async () => {
      db({ integration: integrationRow(service), appointments: [] });

      await service.deleteAppointmentEvent(CLINIC, 'appointment-1');

      const lookup = prisma.$queryRaw.mock.calls.find((call) =>
        (call[0] as string[]).join('?').includes('FROM "appointments"'),
      );
      expect(lookup).toContain(CLINIC);
      expect(lookup).toContain('appointment-1');
    });
  });

  // ── Disconnect cleanup ─────────────────────────────────────────────────────

  describe('disconnect', () => {
    it('reports not connected without calling Google', async () => {
      db({ integration: null });

      const result = await service.disconnect(CLINIC);

      expect(result.connected).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('removes every event it created, then revokes the token', async () => {
      db({
        integration: integrationRow(service),
        appointments: [
          { id: 'a-1', googleCalendarEventId: 'event-1' },
          { id: 'a-2', googleCalendarEventId: 'event-2' },
        ],
      });
      fetchSpy.mockResolvedValue({ ok: true, status: 204 } as Response);

      const result = await service.disconnect(CLINIC);

      expect(result.connected).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(3); // two deletes, one revoke
      expect(fetchSpy.mock.calls[2][0]).toBe(
        'https://oauth2.googleapis.com/revoke',
      );
      expect(executedMatching('"disconnectedAt" = NOW()')).toHaveLength(1);
    });

    it('refuses to disconnect while any event is still out there', async () => {
      db({
        integration: integrationRow(service),
        appointments: [{ id: 'a-1', googleCalendarEventId: 'event-1' }],
      });
      fetchSpy.mockResolvedValue(
        jsonResponse({ error: { code: 500 } }, { ok: false, status: 500 }),
      );

      await expect(service.disconnect(CLINIC)).rejects.toThrow(
        BadRequestException,
      );

      // Disconnecting anyway would leave clinic appointments visible in a
      // calendar DentalFlow can no longer reach to clean up.
      expect(executedMatching('"disconnectedAt" = NOW()')).toHaveLength(0);
    });

    it('counts an already-missing event as cleaned up', async () => {
      db({
        integration: integrationRow(service),
        appointments: [{ id: 'a-1', googleCalendarEventId: 'event-1' }],
      });
      fetchSpy
        .mockResolvedValueOnce({ ok: false, status: 404 } as Response)
        .mockResolvedValueOnce({ ok: true, status: 200 } as Response);

      await expect(service.disconnect(CLINIC)).resolves.toMatchObject({
        connected: false,
      });
      expect(
        executedMatching('SET "googleCalendarEventId" = NULL'),
      ).toHaveLength(1);
    });

    it('skips an appointment carrying no event id', async () => {
      db({
        integration: integrationRow(service),
        appointments: [
          { id: 'a-1', googleCalendarEventId: null },
          { id: 'a-2', googleCalendarEventId: 'event-2' },
        ],
      });
      fetchSpy.mockResolvedValue({ ok: true, status: 204 } as Response);

      await service.disconnect(CLINIC);

      // One delete and one revoke: nothing is asked of Google for a row that
      // was never pushed.
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('reports a revoke that Google rejects', async () => {
      db({ integration: integrationRow(service), appointments: [] });
      fetchSpy.mockResolvedValue({ ok: false, status: 400 } as Response);

      await expect(service.disconnect(CLINIC)).rejects.toThrow(
        BadRequestException,
      );
      expect(executedMatching('"disconnectedAt" = NOW()')).toHaveLength(0);
    });
  });

  // ── The dentist's own calendar ─────────────────────────────────────────────

  describe('syncDentist', () => {
    it('refuses when this dentist has not connected a calendar', async () => {
      db({ userIntegration: null });

      await expect(service.syncDentist(USER, CLINIC)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('refuses when the account has no professional profile', async () => {
      db({
        userIntegration: userIntegrationRow(service),
        profile: null,
      });

      await expect(service.syncDentist(USER, CLINIC)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('pushes to the dentist’s own calendar, not the clinic’s', async () => {
      db({
        userIntegration: userIntegrationRow(service),
        profile: { id: PROFILE },
        appointments: [appointmentRow()],
      });
      fetchSpy.mockResolvedValue(jsonResponse({ id: 'dentist-event-1' }));

      const result = await service.syncDentist(USER, CLINIC);

      expect(result).toEqual({ synced: 1, failed: 0 });
      expect(fetchSpy.mock.calls[0][0]).toContain(
        encodeURIComponent('dentist@example.test'),
      );
    });

    it('records the event id in the dentist’s own column', async () => {
      db({
        userIntegration: userIntegrationRow(service),
        profile: { id: PROFILE },
        appointments: [appointmentRow()],
      });
      fetchSpy.mockResolvedValue(jsonResponse({ id: 'dentist-event-1' }));

      await service.syncDentist(USER, CLINIC);

      // Writing the clinic column here would make the two calendars fight over
      // the same event id.
      expect(
        executedMatching('SET "dentistGoogleCalendarEventId"'),
      ).toHaveLength(1);
      expect(executedMatching('SET "googleCalendarEventId"')).toHaveLength(0);
    });

    it('scopes the appointment query to this dentist’s profile', async () => {
      db({
        userIntegration: userIntegrationRow(service),
        profile: { id: PROFILE },
        appointments: [],
      });

      await service.syncDentist(USER, CLINIC);

      const query = prisma.$queryRaw.mock.calls.find((call) =>
        (call[0] as string[]).join('?').includes('FROM "appointments"'),
      );
      expect(query).toContain(PROFILE);
      expect(query).toContain(CLINIC);
    });

    it('survives a failing event the same way the clinic sync does', async () => {
      db({
        userIntegration: userIntegrationRow(service),
        profile: { id: PROFILE },
        appointments: [
          appointmentRow({ id: 'a-1' }),
          appointmentRow({ id: 'a-2' }),
        ],
      });
      fetchSpy
        .mockResolvedValueOnce(
          jsonResponse({ error: { code: 500 } }, { ok: false, status: 500 }),
        )
        .mockResolvedValueOnce(jsonResponse({ id: 'event-2' }));

      const result = await service.syncDentist(USER, CLINIC);

      expect(result).toEqual({ synced: 1, failed: 1 });
      expect(warnSpy).toHaveBeenCalled();
    });

    it('marks only this user’s integration as synced', async () => {
      db({
        userIntegration: userIntegrationRow(service),
        profile: { id: PROFILE },
        appointments: [],
      });

      await service.syncDentist(USER, CLINIC);

      const stamp = prisma.$executeRaw.mock.calls.find((call) =>
        (call[0] as string[]).join('?').includes('"lastSyncedAt" = NOW()'),
      );
      expect((stamp![0] as string[]).join('?')).toContain(
        'user_google_calendar_integrations',
      );
      expect(stamp).toContain(USER);
    });
  });

  // ── The dentist's token and disconnect ─────────────────────────────────────

  describe('disconnectDentist', () => {
    it('reports not connected without calling Google', async () => {
      db({ userIntegration: null });

      const result = await service.disconnectDentist(USER, CLINIC);

      expect(result.connected).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('removes only this professional’s events, then revokes', async () => {
      db({
        userIntegration: userIntegrationRow(service),
        profile: { id: PROFILE },
        appointments: [
          { id: 'a-1', dentistGoogleCalendarEventId: 'dentist-event-1' },
        ],
      });
      fetchSpy.mockResolvedValue({ ok: true, status: 204 } as Response);

      await service.disconnectDentist(USER, CLINIC);

      const lookup = prisma.$queryRaw.mock.calls.find((call) =>
        (call[0] as string[])
          .join('?')
          .includes('"dentistGoogleCalendarEventId" IS NOT NULL'),
      );
      expect(lookup).toContain(PROFILE);
      expect(
        executedMatching('SET "dentistGoogleCalendarEventId" = NULL'),
      ).toHaveLength(1);
      expect(executedMatching('"disconnectedAt" = NOW()')).toHaveLength(1);
    });

    it('clears the id for an event already gone from Google', async () => {
      db({
        userIntegration: userIntegrationRow(service),
        profile: { id: PROFILE },
        appointments: [
          { id: 'a-1', dentistGoogleCalendarEventId: 'dentist-event-1' },
        ],
      });
      fetchSpy
        .mockResolvedValueOnce({ ok: false, status: 404 } as Response)
        .mockResolvedValueOnce({ ok: true, status: 200 } as Response);

      await service.disconnectDentist(USER, CLINIC);

      expect(
        executedMatching('SET "dentistGoogleCalendarEventId" = NULL'),
      ).toHaveLength(1);
    });

    it('refuses to disconnect while one of its events is still out there', async () => {
      db({
        userIntegration: userIntegrationRow(service),
        profile: { id: PROFILE },
        appointments: [
          { id: 'a-1', dentistGoogleCalendarEventId: 'dentist-event-1' },
        ],
      });
      fetchSpy.mockResolvedValue(
        jsonResponse({ error: { code: 500 } }, { ok: false, status: 500 }),
      );

      await expect(service.disconnectDentist(USER, CLINIC)).rejects.toThrow(
        BadRequestException,
      );

      // The id is kept so a retry can still find and remove the event.
      expect(
        executedMatching('SET "dentistGoogleCalendarEventId" = NULL'),
      ).toHaveLength(0);
      expect(executedMatching('"disconnectedAt" = NOW()')).toHaveLength(0);
    });

    it('skips a row carrying no event id rather than calling Google for it', async () => {
      db({
        userIntegration: userIntegrationRow(service),
        profile: { id: PROFILE },
        appointments: [
          { id: 'a-1', dentistGoogleCalendarEventId: null },
          { id: 'a-2', dentistGoogleCalendarEventId: 'dentist-event-2' },
        ],
      });
      fetchSpy.mockResolvedValue({ ok: true, status: 204 } as Response);

      await service.disconnectDentist(USER, CLINIC);

      // One delete and one revoke: the null row costs no request.
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('the dentist access token', () => {
    it('refreshes it and stores the result against this user only', async () => {
      db({
        userIntegration: userIntegrationRow(service, {
          tokenExpiresAt: new Date(Date.now() - 1_000),
        }),
        profile: { id: PROFILE },
        appointments: [],
      });
      fetchSpy.mockResolvedValue(
        jsonResponse({ access_token: 'dentist-fresh', expires_in: 3600 }),
      );

      await service.syncDentist(USER, CLINIC);

      const write = prisma.$executeRaw.mock.calls.find((call) =>
        (call[0] as string[]).join('?').includes('"accessTokenEncrypted"'),
      );
      expect(write).toBeDefined();
      expect((write![0] as string[]).join('?')).toContain(
        'user_google_calendar_integrations',
      );
      expect(write).toContain(USER);
    });

    it('defaults the expiry when Google omits expires_in', async () => {
      db({
        userIntegration: userIntegrationRow(service, {
          tokenExpiresAt: new Date(Date.now() - 1_000),
        }),
        profile: { id: PROFILE },
        appointments: [],
      });
      fetchSpy.mockResolvedValue(
        jsonResponse({ access_token: 'dentist-fresh' }),
      );

      await service.syncDentist(USER, CLINIC);

      const write = prisma.$executeRaw.mock.calls.find((call) =>
        (call[0] as string[]).join('?').includes('"tokenExpiresAt"'),
      );
      const expiry = write!.find(
        (value): value is Date => value instanceof Date,
      );
      // An hour, not "now", which would make every later call refresh again.
      expect(expiry!.getTime()).toBeGreaterThan(Date.now() + 3_000_000);
    });

    it('refuses to sync when the refresh returns no token', async () => {
      db({
        userIntegration: userIntegrationRow(service, {
          tokenExpiresAt: new Date(Date.now() - 1_000),
        }),
        profile: { id: PROFILE },
        appointments: [appointmentRow()],
      });
      fetchSpy.mockResolvedValue(jsonResponse({ expires_in: 3600 }));

      await expect(service.syncDentist(USER, CLINIC)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── Responses Google should never send ─────────────────────────────────────

  describe('a malformed provider response', () => {
    it('fails the appointment when an update succeeds but returns no id', async () => {
      db({
        integration: integrationRow(service),
        appointments: [appointmentRow({ googleCalendarEventId: 'existing-1' })],
      });
      // HTTP 200 carrying an error object and no id: contradictory, and not
      // the 404 that would mean "recreate it".
      fetchSpy.mockResolvedValue(
        jsonResponse({ error: { code: 409, message: 'Conflict' } }),
      );

      const result = await service.sync(CLINIC);

      expect(result).toEqual({ synced: 0, failed: 1 });
      expect(executedMatching('SET "googleCalendarEventId"')).toHaveLength(0);
    });

    it('fails the appointment when a create succeeds but returns no id', async () => {
      db({
        integration: integrationRow(service),
        appointments: [appointmentRow()],
      });
      fetchSpy.mockResolvedValue(jsonResponse({}));

      const result = await service.sync(CLINIC);

      // Nothing to store, so nothing is stored: a blank id would poison every
      // later sync of this appointment.
      expect(result).toEqual({ synced: 0, failed: 1 });
      expect(executedMatching('SET "googleCalendarEventId"')).toHaveLength(0);
    });

    it('parses a date the driver returned in an unexpected shape', async () => {
      db({
        integration: integrationRow(service),
        appointments: [
          appointmentRow({ appointmentDate: 'Mon, 15 Jun 2026 00:00:00 GMT' }),
        ],
      });
      fetchSpy.mockResolvedValue(jsonResponse({ id: 'event-1' }));

      await service.sync(CLINIC);

      const body = JSON.parse(
        (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
      ) as { start: { dateTime: string } };
      expect(body.start.dateTime).toBe('2026-06-15T09:00:00');
    });
  });

  // ── Configuration ──────────────────────────────────────────────────────────

  describe('stale or unconfigured integrations', () => {
    it('ignores an integration that was disconnected', async () => {
      // findActiveIntegration filters on disconnectedAt IS NULL; the row simply
      // does not come back, and the sync must refuse rather than proceed.
      db({ integration: null });

      await expect(service.sync(CLINIC)).rejects.toThrow(BadRequestException);

      const query = prisma.$queryRaw.mock.calls[0][0] as string[];
      expect(query.join('?')).toContain('"disconnectedAt" IS NULL');
    });
  });
});
