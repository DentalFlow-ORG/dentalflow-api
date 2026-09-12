import { Logger } from '@nestjs/common';

import { LocalNotificationProvider } from './local-notification.provider';
import { WhatsAppCloudProvider } from './whatsapp-cloud.provider';
import type { SendPayload } from './notification-provider.interface';

/**
 * The two notification providers behind `INotificationProvider`.
 *
 * The local one must never reach the network and must never log a full phone
 * number. The Meta Cloud one owns the outbound boundary: number
 * normalisation, template parameters, and translating provider failures into
 * a message an operator can act on — an expired token and an unapproved
 * template need different responses, and "Erro 500" tells nobody anything.
 */

const PAYLOAD: SendPayload = {
  clinicId: 'clinic-1',
  consentId: 'consent-1',
  appointmentId: null,
  templateSlug: 'appointment_reminder',
  phone: '11999998888',
  channel: 'WHATSAPP',
  scope: 'UTILITY',
};

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

describe('LocalNotificationProvider', () => {
  let provider: LocalNotificationProvider;
  let log: jest.SpyInstance;

  beforeEach(() => {
    provider = new LocalNotificationProvider();
    log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns no provider reference, because nothing was actually sent', async () => {
    await expect(provider.send(PAYLOAD)).resolves.toEqual({
      providerRef: null,
    });
  });

  it('makes no network call', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await provider.send(PAYLOAD);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('masks the phone number in its log, keeping only the last four digits', async () => {
    await provider.send(PAYLOAD);

    const line = String(log.mock.calls[0][0]);
    expect(line).toContain('***8888');
    expect(line).not.toContain('11999998888');
  });

  it('masks a short number entirely', async () => {
    await provider.send({ ...PAYLOAD, phone: '1234' });

    const line = String(log.mock.calls[0][0]);
    expect(line).toContain('****');
    expect(line).not.toContain('1234');
  });

  it('strips formatting before masking', async () => {
    await provider.send({ ...PAYLOAD, phone: '+55 (11) 99999-8888' });
    expect(String(log.mock.calls[0][0])).toContain('***8888');
  });

  it('records the template and appointment being simulated', async () => {
    await provider.send({ ...PAYLOAD, appointmentId: 'appt-9' });

    const line = String(log.mock.calls[0][0]);
    expect(line).toContain('appointment_reminder');
    expect(line).toContain('appt-9');
  });

  it('says so when there is no appointment', async () => {
    await provider.send(PAYLOAD);
    expect(String(log.mock.calls[0][0])).toContain('none');
  });
});

describe('WhatsAppCloudProvider', () => {
  let prisma: { appointment: { findUnique: jest.Mock } };
  let provider: WhatsAppCloudProvider;
  let fetchSpy: jest.SpyInstance;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      WHATSAPP_CLOUD_API_VERSION: 'v21.0',
      WHATSAPP_CLOUD_PHONE_NUMBER_ID: '1234567890',
      WHATSAPP_CLOUD_ACCESS_TOKEN: 'test-access-token',
      WHATSAPP_DEFAULT_LANGUAGE: 'pt_BR',
    };
    prisma = { appointment: { findUnique: jest.fn().mockResolvedValue(null) } };
    provider = new WhatsAppCloudProvider(prisma as never);
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ messages: [{ id: 'wamid.123' }] }));
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  function requestBody() {
    return JSON.parse(String(fetchSpy.mock.calls[0][1].body));
  }

  // ── Configuration ──────────────────────────────────────────────────────────

  describe('configuration', () => {
    it('refuses to send with no phone number id', async () => {
      delete process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID;
      await expect(provider.send(PAYLOAD)).rejects.toThrow(/nao configurada/i);
    });

    it('refuses to send with no access token', async () => {
      delete process.env.WHATSAPP_CLOUD_ACCESS_TOKEN;
      await expect(provider.send(PAYLOAD)).rejects.toThrow(/nao configurada/i);
    });

    it('makes no network call when unconfigured', async () => {
      delete process.env.WHATSAPP_CLOUD_ACCESS_TOKEN;
      await provider.send(PAYLOAD).catch(() => undefined);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('names the variables that are missing', async () => {
      delete process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID;
      await expect(provider.send(PAYLOAD)).rejects.toThrow(
        /WHATSAPP_CLOUD_PHONE_NUMBER_ID/,
      );
    });

    it('falls back to a default API version and language', async () => {
      delete process.env.WHATSAPP_CLOUD_API_VERSION;
      delete process.env.WHATSAPP_DEFAULT_LANGUAGE;

      await provider.send(PAYLOAD);

      expect(String(fetchSpy.mock.calls[0][0])).toContain('/v19.0/');
      expect(requestBody().template.language.code).toBe('pt_BR');
    });

    it('sends the access token as a bearer credential', async () => {
      await provider.send(PAYLOAD);
      expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe(
        'Bearer test-access-token',
      );
    });

    it('posts to the configured phone number id', async () => {
      await provider.send(PAYLOAD);
      expect(String(fetchSpy.mock.calls[0][0])).toBe(
        'https://graph.facebook.com/v21.0/1234567890/messages',
      );
    });
  });

  // ── Number normalisation ───────────────────────────────────────────────────

  describe('phone normalisation', () => {
    it('adds the Brazil country code to a local number', async () => {
      await provider.send({ ...PAYLOAD, phone: '11999998888' });
      expect(requestBody().to).toBe('+5511999998888');
    });

    it('does not double the country code when it is already present', async () => {
      await provider.send({ ...PAYLOAD, phone: '5511999998888' });
      expect(requestBody().to).toBe('+5511999998888');
    });

    it('strips punctuation before normalising', async () => {
      await provider.send({ ...PAYLOAD, phone: '+55 (11) 99999-8888' });
      expect(requestBody().to).toBe('+5511999998888');
    });
  });

  // ── Template parameters ────────────────────────────────────────────────────

  describe('template components', () => {
    it('sends no parameters when the message is not tied to an appointment', async () => {
      await provider.send(PAYLOAD);

      expect(requestBody().template.components).toEqual([]);
      expect(prisma.appointment.findUnique).not.toHaveBeenCalled();
    });

    it('sends no parameters when the appointment no longer exists', async () => {
      await provider.send({ ...PAYLOAD, appointmentId: 'gone' });
      expect(requestBody().template.components).toEqual([]);
    });

    it('fills patient, date, time and clinic from the appointment', async () => {
      prisma.appointment.findUnique.mockResolvedValue({
        patientName: 'Maria Silva',
        appointmentDate: new Date('2026-06-15T00:00:00.000Z'),
        startTime: new Date('2026-06-15T14:30:00.000Z'),
        clinic: { name: 'Alpha Odonto' },
      });

      await provider.send({ ...PAYLOAD, appointmentId: 'appt-1' });

      expect(requestBody().template.components[0].parameters).toEqual([
        { type: 'text', text: 'Maria Silva' },
        { type: 'text', text: '15/06/2026' },
        { type: 'text', text: '14:30' },
        { type: 'text', text: 'Alpha Odonto' },
      ]);
    });

    it('sends an empty clinic name rather than "undefined"', async () => {
      prisma.appointment.findUnique.mockResolvedValue({
        patientName: 'Maria',
        appointmentDate: new Date('2026-06-15T00:00:00.000Z'),
        startTime: new Date('2026-06-15T09:00:00.000Z'),
        clinic: null,
      });

      await provider.send({ ...PAYLOAD, appointmentId: 'appt-1' });

      const params = requestBody().template.components[0].parameters;
      expect(params[3]).toEqual({ type: 'text', text: '' });
    });

    it('degrades gracefully when the stored date is invalid', async () => {
      prisma.appointment.findUnique.mockResolvedValue({
        patientName: 'Maria',
        appointmentDate: new Date('invalid'),
        startTime: new Date('invalid'),
        clinic: { name: 'Alpha' },
      });

      await provider.send({ ...PAYLOAD, appointmentId: 'appt-1' });

      const params = requestBody().template.components[0].parameters;
      expect(params[1].text).toBe('Data não informada');
      expect(params[2].text).toBe('Hora não informada');
    });

    it('sends the template by slug as a template message', async () => {
      await provider.send(PAYLOAD);

      const body = requestBody();
      expect(body.messaging_product).toBe('whatsapp');
      expect(body.type).toBe('template');
      expect(body.template.name).toBe('appointment_reminder');
    });
  });

  // ── Success ────────────────────────────────────────────────────────────────

  describe('success', () => {
    it('returns the Meta message id so the send can be traced', async () => {
      await expect(provider.send(PAYLOAD)).resolves.toEqual({
        providerRef: 'wamid.123',
      });
    });

    it('returns a null reference when Meta accepts without returning an id', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({}));
      await expect(provider.send(PAYLOAD)).resolves.toEqual({
        providerRef: null,
      });
    });
  });

  // ── Failure translation ────────────────────────────────────────────────────

  describe('failure translation', () => {
    it('explains an expired token on 401', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({}, { ok: false, status: 401 }));

      await expect(provider.send(PAYLOAD)).rejects.toThrow(
        /Token de acesso inválido ou expirado/,
      );
    });

    it('explains an expired token on Meta error code 190 whatever the status', async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(
          { error: { message: 'expired', code: 190 } },
          { ok: false, status: 403 },
        ),
      );

      await expect(provider.send(PAYLOAD)).rejects.toThrow(
        /Token de acesso inválido ou expirado/,
      );
    });

    it('points at template approval on 400 and names the template', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({}, { ok: false, status: 400 }));

      await expect(provider.send(PAYLOAD)).rejects.toThrow(
        /template "appointment_reminder"/,
      );
    });

    it('reports the status and Meta code for any other failure', async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(
          { error: { message: 'boom', code: 131_026 } },
          { ok: false, status: 500 },
        ),
      );

      await expect(provider.send(PAYLOAD)).rejects.toThrow(/Erro 500.*131026/s);
    });

    it('says "unknown" when Meta returns no error code', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({}, { ok: false, status: 503 }));
      await expect(provider.send(PAYLOAD)).rejects.toThrow(/unknown/);
    });

    it('survives a response body that is not JSON', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 502,
        json: () => Promise.reject(new Error('not json')),
      } as unknown as Response);

      await expect(provider.send(PAYLOAD)).rejects.toThrow(/Erro 502/);
    });

    it('never puts the access token into the error it raises', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({}, { ok: false, status: 401 }));

      await expect(provider.send(PAYLOAD)).rejects.toThrow(
        expect.objectContaining({
          message: expect.not.stringContaining(
            'test-access-token',
          ) as unknown as string,
        }) as never,
      );
    });

    it('never logs the access token or the recipient number', async () => {
      const errorLog = jest.spyOn(Logger.prototype, 'error');
      fetchSpy.mockResolvedValue(jsonResponse({}, { ok: false, status: 401 }));

      await provider.send(PAYLOAD).catch(() => undefined);

      const logged = JSON.stringify(errorLog.mock.calls);
      expect(logged).not.toContain('test-access-token');
      expect(logged).not.toContain('11999998888');
    });
  });
});
