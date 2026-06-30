import 'reflect-metadata';
import type { Response } from 'express';

import { CalendarIntegrationsController } from './calendar-integrations.controller';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockIntegrationsService = {
  resolveCallbackRedirectRole: jest.fn(),
  handleCallback: jest.fn(),
};

const mockAccessPolicy = {
  assertClinicMember: jest.fn(),
  assertOwnerAccess: jest.fn(),
};

// ── Response builder ───────────────────────────────────────────────────────────

function buildRes() {
  const redirectFn = jest.fn();
  const res = { redirect: redirectFn } as unknown as Response;
  return { res, redirectFn };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('CalendarIntegrationsController.callback', () => {
  let controller: CalendarIntegrationsController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new CalendarIntegrationsController(
      mockIntegrationsService as never,
      mockAccessPolicy as never,
    );
  });

  it('redirects OWNER to /app/agendamentos on success', async () => {
    mockIntegrationsService.resolveCallbackRedirectRole.mockResolvedValue('OWNER');
    mockIntegrationsService.handleCallback.mockResolvedValue(undefined);
    const { res, redirectFn } = buildRes();

    await controller.callback('code-1', 'state-owner', undefined, res);

    const redirectUrl = new URL(redirectFn.mock.calls[0][0]);
    expect(redirectUrl.pathname).toBe('/app/agendamentos');
    expect(redirectUrl.searchParams.get('googleCalendar')).toBe('connected');
  });

  it('redirects DENTIST to /app/agenda on success', async () => {
    mockIntegrationsService.resolveCallbackRedirectRole.mockResolvedValue('DENTIST');
    mockIntegrationsService.handleCallback.mockResolvedValue(undefined);
    const { res, redirectFn } = buildRes();

    await controller.callback('code-1', 'state-dentist', undefined, res);

    const redirectUrl = new URL(redirectFn.mock.calls[0][0]);
    expect(redirectUrl.pathname).toBe('/app/agenda');
    expect(redirectUrl.searchParams.get('googleCalendar')).toBe('connected');
  });

  it('redirects OWNER to /app/agendamentos with error message on Google error param', async () => {
    mockIntegrationsService.resolveCallbackRedirectRole.mockResolvedValue('OWNER');
    const { res, redirectFn } = buildRes();

    await controller.callback(undefined, 'state-owner', 'access_denied', res);

    const redirectUrl = new URL(redirectFn.mock.calls[0][0]);
    expect(redirectUrl.pathname).toBe('/app/agendamentos');
    expect(redirectUrl.searchParams.get('googleCalendar')).toBe('error');
    expect(redirectUrl.searchParams.get('message')).toBeTruthy();
    expect(mockIntegrationsService.handleCallback).not.toHaveBeenCalled();
  });

  it('redirects DENTIST to /app/agenda with error message on Google error param', async () => {
    mockIntegrationsService.resolveCallbackRedirectRole.mockResolvedValue('DENTIST');
    const { res, redirectFn } = buildRes();

    await controller.callback(undefined, 'state-dentist', 'access_denied', res);

    const redirectUrl = new URL(redirectFn.mock.calls[0][0]);
    expect(redirectUrl.pathname).toBe('/app/agenda');
    expect(redirectUrl.searchParams.get('googleCalendar')).toBe('error');
    expect(redirectUrl.searchParams.get('message')).toBeTruthy();
  });

  it('falls back to /app/agendamentos when state is invalid/unknown', async () => {
    mockIntegrationsService.resolveCallbackRedirectRole.mockResolvedValue(null);
    mockIntegrationsService.handleCallback.mockRejectedValue(
      new Error('Sessão de conexão do Google Agenda expirada.'),
    );
    const { res, redirectFn } = buildRes();

    await controller.callback('code-1', 'unknown-state', undefined, res);

    const redirectUrl = new URL(redirectFn.mock.calls[0][0]);
    expect(redirectUrl.pathname).toBe('/app/agendamentos');
    expect(redirectUrl.searchParams.get('googleCalendar')).toBe('error');
    expect(redirectUrl.searchParams.get('message')).toBe(
      'Sessão de conexão do Google Agenda expirada.',
    );
  });
});
