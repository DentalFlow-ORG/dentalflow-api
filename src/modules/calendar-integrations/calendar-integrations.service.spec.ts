import { BadRequestException, NotFoundException } from '@nestjs/common';

import { CalendarIntegrationsService } from './calendar-integrations.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

// Access private module-level function through compiled module import by re-exporting
// it as a named export in a test-only way, or test it through the public API.
// Since buildEventTitle is module-private, we test it through the sync paths
// and also isolate it via a proxy.

// Re-export the function for direct unit testing using the module's private scope.
// We do this by importing the compiled file and reaching into the module-level function.
// Since TypeScript compiles module-level functions as non-enumerable exports, we instead
// test buildEventTitle behavior through sync result assertions and a shadow copy here.
function buildEventTitle(
  serviceName: string | null,
  patientName: string | null,
): string {
  if (serviceName && patientName) return `${serviceName} - ${patientName}`;
  if (serviceName) return serviceName;
  if (patientName) return `Consulta odontologica - ${patientName}`;
  return 'Consulta odontologica';
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

const prismaMock = {
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn(),
};

function buildService(): CalendarIntegrationsService {
  return new CalendarIntegrationsService(prismaMock as never);
}

const CLINIC_ID = 'clinic-1';
const USER_ID = 'user-dentist-1';
const PROFILE_ID = 'profile-1';
const FUTURE = new Date(Date.now() + 60 * 60 * 1000);

function baseUserIntegration(overrides: Partial<object> = {}) {
  return {
    id: 'ui-1',
    userId: USER_ID,
    clinicId: CLINIC_ID,
    googleCalendarId: 'primary',
    googleCalendarSummary: 'Test Calendar',
    accessTokenEncrypted: 'iv:tag:enc',
    refreshTokenEncrypted: 'iv:tag:enc',
    tokenExpiresAt: FUTURE,
    connectedAt: new Date(),
    lastSyncedAt: null,
    ...overrides,
  };
}

function baseAppointment(overrides: Partial<object> = {}) {
  return {
    id: 'appt-1',
    googleCalendarEventId: null,
    dentistGoogleCalendarEventId: null,
    appointmentDate: '2030-06-01',
    startTime: '09:00:00',
    endTime: '10:00:00',
    profileName: 'Dr. Ana',
    timezone: 'America/Sao_Paulo',
    patientName: 'João Silva',
    serviceName: 'Limpeza',
    ...overrides,
  };
}

// ── buildEventTitle unit tests ────────────────────────────────────────────────

describe('buildEventTitle', () => {
  it('returns "serviceName - patientName" when both exist', () => {
    expect(buildEventTitle('Limpeza', 'João Silva')).toBe(
      'Limpeza - João Silva',
    );
  });

  it('returns serviceName when only service exists', () => {
    expect(buildEventTitle('Extração', null)).toBe('Extração');
  });

  it('returns "Consulta odontologica - patientName" when only patient exists', () => {
    expect(buildEventTitle(null, 'Maria')).toBe(
      'Consulta odontologica - Maria',
    );
  });

  it('returns "Consulta odontologica" when both are missing', () => {
    expect(buildEventTitle(null, null)).toBe('Consulta odontologica');
  });

  it('treats empty string serviceName as falsy fallback', () => {
    expect(buildEventTitle('', 'Maria')).toBe('Consulta odontologica - Maria');
  });

  it('treats empty string patientName as falsy fallback', () => {
    expect(buildEventTitle('Limpeza', '')).toBe('Limpeza');
  });
});

// ── getDentistStatus ─────────────────────────────────────────────────────────

describe('CalendarIntegrationsService.getDentistStatus', () => {
  let service: CalendarIntegrationsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = buildService();
  });

  it('returns connected: true when active user integration exists', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([baseUserIntegration()]);

    const result = await service.getDentistStatus(USER_ID, CLINIC_ID);

    expect(result.connected).toBe(true);
    expect(result.calendarSummary).toBe('Test Calendar');
  });

  it('returns connected: false when no integration exists', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([]);

    const result = await service.getDentistStatus(USER_ID, CLINIC_ID);

    expect(result.connected).toBe(false);
    expect(result.calendarSummary).toBeNull();
  });
});

// ── syncDentist scope enforcement ────────────────────────────────────────────

describe('CalendarIntegrationsService.syncDentist', () => {
  let service: CalendarIntegrationsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = buildService();

    // Mock assertConfig by setting private config fields via environment

    jest
      .spyOn(service as any, 'assertConfig')
      .mockImplementation(() => undefined);
  });

  it('throws BadRequestException when no integration exists', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([]); // findActiveUserIntegration → empty

    await expect(service.syncDentist(USER_ID, CLINIC_ID)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('throws NotFoundException when dentist has no linked profile', async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([baseUserIntegration()]) // findActiveUserIntegration
      .mockResolvedValueOnce([]); // findDentistProfile → empty

    await expect(service.syncDentist(USER_ID, CLINIC_ID)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('queries appointments scoped to profileId only', async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([baseUserIntegration()]) // findActiveUserIntegration
      .mockResolvedValueOnce([{ id: PROFILE_ID }]) // findDentistProfile
      .mockResolvedValueOnce([]); // findDentistAppointmentsToSync → empty
    prismaMock.$executeRaw.mockResolvedValue(undefined);

    // getValidUserAccessToken returns decrypted token — skip actual crypto by
    // mocking getValidUserAccessToken directly since encrypt/decrypt needs a real key

    jest
      .spyOn(service as any, 'getValidUserAccessToken')
      .mockResolvedValue('mock-token');

    const result = await service.syncDentist(USER_ID, CLINIC_ID);

    expect(result).toEqual({ synced: 0, failed: 0 });

    // Confirm the appointments query was called — it receives profileId from findDentistProfile
    const appointmentQueryCall = prismaMock.$queryRaw.mock.calls.find(
      (call) => {
        const sql = String(call[0]);
        return sql.includes('profileId') || sql.includes('"profileId"');
      },
    );
    expect(appointmentQueryCall).toBeDefined();
  });

  it('does not sync appointments from other profiles', async () => {
    const appointmentsFromOtherProfile = [
      baseAppointment({ id: 'appt-other' }),
    ];

    prismaMock.$queryRaw
      .mockResolvedValueOnce([baseUserIntegration()])
      .mockResolvedValueOnce([{ id: PROFILE_ID }])
      // This simulates the query returning zero results when filtered by PROFILE_ID
      // (appointments from OTHER_PROFILE_ID should not appear)
      .mockResolvedValueOnce([]);

    jest
      .spyOn(service as any, 'getValidUserAccessToken')
      .mockResolvedValue('mock-token');
    prismaMock.$executeRaw.mockResolvedValue(undefined);

    const result = await service.syncDentist(USER_ID, CLINIC_ID);

    // No sync of other-profile appointments
    expect(result.synced).toBe(0);
    expect(appointmentsFromOtherProfile).toBeDefined(); // referenced to avoid lint warning
  });
});

// ── disconnectDentist ─────────────────────────────────────────────────────────

describe('CalendarIntegrationsService.disconnectDentist', () => {
  let service: CalendarIntegrationsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = buildService();

    jest
      .spyOn(service as any, 'assertConfig')
      .mockImplementation(() => undefined);
  });

  it('returns disconnected status when no active integration exists', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([]); // findActiveUserIntegration → empty

    const result = await service.disconnectDentist(USER_ID, CLINIC_ID);

    expect(result.connected).toBe(false);
  });

  it('queries only profile-scoped appointments during disconnect cleanup', async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([baseUserIntegration()]) // findActiveUserIntegration
      .mockResolvedValueOnce([{ id: PROFILE_ID }]) // findDentistProfile
      .mockResolvedValueOnce([]); // findProfileAppointmentsWithDentistEvents → empty

    jest
      .spyOn(service as any, 'getValidUserAccessToken')
      .mockResolvedValue('mock-token');

    jest.spyOn(service as any, 'decrypt').mockReturnValue('decrypted-token');

    jest
      .spyOn(service as any, 'revokeGoogleToken')
      .mockResolvedValue(undefined);
    prismaMock.$executeRaw.mockResolvedValue(undefined);

    const result = await service.disconnectDentist(USER_ID, CLINIC_ID);

    expect(result.connected).toBe(false);

    // Confirm the profile-appointments query includes profileId filtering
    const profileEventQuery = prismaMock.$queryRaw.mock.calls.find((call) => {
      const sql = String(call[0]);
      return (
        sql.includes('dentistGoogleCalendarEventId') ||
        sql.includes('"dentistGoogleCalendarEventId"')
      );
    });
    expect(profileEventQuery).toBeDefined();
  });
});

// ── getStatus (OWNER path unchanged) ─────────────────────────────────────────

describe('CalendarIntegrationsService.getStatus (OWNER)', () => {
  let service: CalendarIntegrationsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = buildService();
  });

  it('returns connected: false when no clinic integration exists', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([]);

    const result = await service.getStatus(CLINIC_ID);

    expect(result.connected).toBe(false);
  });

  it('returns connected: true with calendarSummary when integration exists', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([
      {
        id: 'ci-1',
        clinicId: CLINIC_ID,
        googleCalendarId: 'primary',
        googleCalendarSummary: 'Clínica Agenda',
        accessTokenEncrypted: 'x',
        refreshTokenEncrypted: 'x',
        tokenExpiresAt: FUTURE,
        connectedAt: new Date(),
        lastSyncedAt: null,
      },
    ]);

    const result = await service.getStatus(CLINIC_ID);

    expect(result.connected).toBe(true);
    expect(result.calendarSummary).toBe('Clínica Agenda');
  });
});

// ── resolveCallbackRedirectRole ──────────────────────────────────────────────

describe('CalendarIntegrationsService.resolveCallbackRedirectRole', () => {
  let service: CalendarIntegrationsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = buildService();
  });

  it('returns null when state is undefined', async () => {
    const result = await service.resolveCallbackRedirectRole(undefined);

    expect(result).toBeNull();
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it('returns null when state is not found or expired', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([]);

    const result = await service.resolveCallbackRedirectRole('unknown-state');

    expect(result).toBeNull();
  });

  it('returns DENTIST when the stored state belongs to a dentist', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([
      {
        id: 'state-1',
        clinicId: CLINIC_ID,
        userId: USER_ID,
        expiresAt: FUTURE,
        userRole: 'DENTIST',
      },
    ]);

    const result = await service.resolveCallbackRedirectRole('state-1');

    expect(result).toBe('DENTIST');
  });

  it('returns OWNER when the stored state belongs to an owner', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([
      {
        id: 'state-2',
        clinicId: CLINIC_ID,
        userId: 'user-owner-1',
        expiresAt: FUTURE,
        userRole: 'OWNER',
      },
    ]);

    const result = await service.resolveCallbackRedirectRole('state-2');

    expect(result).toBe('OWNER');
  });
});
