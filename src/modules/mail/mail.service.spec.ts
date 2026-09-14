jest.mock('resend', () => ({
  Resend: jest.fn(),
}));

import { Logger } from '@nestjs/common';
import { Resend } from 'resend';

import { MailService } from './mail.service';

const MockResend = Resend as jest.MockedClass<typeof Resend>;

// ── Env helpers ───────────────────────────────────────────────────────────────

const MANAGED_KEYS = [
  'RESEND_API_KEY',
  'MAIL_FROM',
  'FRONTEND_URL',
  'NODE_ENV',
] as const;
type ManagedKey = (typeof MANAGED_KEYS)[number];

const savedEnv: Partial<Record<ManagedKey, string | undefined>> = {};

function saveEnv(): void {
  for (const key of MANAGED_KEYS) {
    savedEnv[key] = process.env[key];
  }
}

function restoreEnv(): void {
  for (const key of MANAGED_KEYS) {
    const saved = savedEnv[key];
    if (saved !== undefined) {
      process.env[key] = saved;
    } else {
      delete process.env[key];
    }
  }
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('MailService', () => {
  let service: MailService;
  let mockSend: jest.Mock;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeAll(() => {
    saveEnv();
  });

  afterAll(() => {
    restoreEnv();
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Silence logger output in tests while still capturing calls
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    // Default: no provider configured, dev/test environment
    delete process.env.RESEND_API_KEY;
    delete process.env.MAIL_FROM;
    delete process.env.FRONTEND_URL;
    process.env.NODE_ENV = 'test';

    // Fresh Resend mock instance per test
    mockSend = jest
      .fn()
      .mockResolvedValue({ data: { id: 'email-id-123' }, error: null });
    MockResend.mockImplementation(
      () => ({ emails: { send: mockSend } }) as unknown as Resend,
    );

    service = new MailService();
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // ── Stub behavior — no RESEND_API_KEY ────────────────────────────────────────

  describe('when RESEND_API_KEY is not set', () => {
    describe('in a non-production environment', () => {
      it('logs the reset link and does not throw', async () => {
        process.env.NODE_ENV = 'development';

        await expect(
          service.sendPasswordResetEmail('user@clinic.com', 'raw-token-abc123'),
        ).resolves.toBeUndefined();

        expect(logSpy).toHaveBeenCalledTimes(1);
        const loggedMessage: string = logSpy.mock.calls[0][0];
        expect(loggedMessage).toContain('raw-token-abc123');
        expect(loggedMessage).toContain('/recuperar-senha/redefinir?token=');
      });

      it('includes FRONTEND_URL in the logged link when configured', async () => {
        process.env.FRONTEND_URL = 'http://localhost:4000';

        await service.sendPasswordResetEmail('user@clinic.com', 'tok123');

        expect(logSpy).toHaveBeenCalledTimes(1);
        const loggedMessage: string = logSpy.mock.calls[0][0];
        expect(loggedMessage).toContain(
          'http://localhost:4000/recuperar-senha/redefinir?token=tok123',
        );
      });

      it('falls back to http://localhost:5173 when FRONTEND_URL is not set', async () => {
        await service.sendPasswordResetEmail('user@clinic.com', 'tok456');

        const loggedMessage: string = logSpy.mock.calls[0][0];
        expect(loggedMessage).toContain(
          'http://localhost:5173/recuperar-senha/redefinir?token=tok456',
        );
      });

      it('does not instantiate Resend', async () => {
        await service.sendPasswordResetEmail(
          'user@clinic.com',
          'raw-token-abc123',
        );

        expect(MockResend).not.toHaveBeenCalled();
      });
    });

    describe('in production', () => {
      beforeEach(() => {
        process.env.NODE_ENV = 'production';
      });

      it('logs a safe warning and does not throw', async () => {
        await expect(
          service.sendPasswordResetEmail('user@clinic.com', 'raw-token-abc123'),
        ).resolves.toBeUndefined();

        expect(warnSpy).toHaveBeenCalledTimes(1);
      });

      it('does not log the reset token', async () => {
        await service.sendPasswordResetEmail(
          'user@clinic.com',
          'raw-token-abc123',
        );

        const allLogs = [
          ...logSpy.mock.calls,
          ...warnSpy.mock.calls,
          ...errorSpy.mock.calls,
        ]
          .flat()
          .join(' ');

        expect(allLogs).not.toContain('raw-token-abc123');
      });

      it('does not log the reset link', async () => {
        await service.sendPasswordResetEmail(
          'user@clinic.com',
          'raw-token-abc123',
        );

        const allLogs = [
          ...logSpy.mock.calls,
          ...warnSpy.mock.calls,
          ...errorSpy.mock.calls,
        ]
          .flat()
          .join(' ');

        expect(allLogs).not.toContain('/recuperar-senha/redefinir');
      });

      it('does not instantiate Resend', async () => {
        await service.sendPasswordResetEmail(
          'user@clinic.com',
          'raw-token-abc123',
        );

        expect(MockResend).not.toHaveBeenCalled();
      });
    });
  });

  // ── Resend configured ────────────────────────────────────────────────────────

  describe('when RESEND_API_KEY is set', () => {
    beforeEach(() => {
      process.env.RESEND_API_KEY = 're_test_key_123';
      process.env.MAIL_FROM = 'DentalFlow <no-reply@dentalflow.com.br>';
      process.env.FRONTEND_URL = 'https://app.dentalflow.com.br';
    });

    it('instantiates Resend with the API key', async () => {
      await service.sendPasswordResetEmail('user@clinic.com', 'raw-token-xyz');

      expect(MockResend).toHaveBeenCalledWith('re_test_key_123');
    });

    it('calls emails.send with the correct to, from, and subject', async () => {
      await service.sendPasswordResetEmail(
        'dentist@clinic.com',
        'raw-token-xyz',
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'dentist@clinic.com',
          from: 'DentalFlow <no-reply@dentalflow.com.br>',
          subject: 'Redefinição de senha — DentalFlow',
        }),
      );
    });

    it('includes the reset link in the HTML body', async () => {
      await service.sendPasswordResetEmail('user@clinic.com', 'my-raw-token');

      const { html } = mockSend.mock.calls[0][0] as { html: string };
      expect(html).toContain(
        'https://app.dentalflow.com.br/recuperar-senha/redefinir?token=my-raw-token',
      );
    });

    it('includes the reset link in the plain-text body', async () => {
      await service.sendPasswordResetEmail('user@clinic.com', 'my-raw-token');

      const { text } = mockSend.mock.calls[0][0] as { text: string };
      expect(text).toContain(
        'https://app.dentalflow.com.br/recuperar-senha/redefinir?token=my-raw-token',
      );
    });

    it('resolves without throwing on success', async () => {
      await expect(
        service.sendPasswordResetEmail('user@clinic.com', 'raw-token-xyz'),
      ).resolves.toBeUndefined();
    });

    describe('when emails.send returns a Resend error object', () => {
      beforeEach(() => {
        mockSend.mockResolvedValue({
          data: null,
          error: {
            name: 'validation_error',
            message: 'Invalid from address',
            statusCode: 422,
          },
        });
      });

      it('does not throw', async () => {
        await expect(
          service.sendPasswordResetEmail('user@clinic.com', 'raw-token-xyz'),
        ).resolves.toBeUndefined();
      });

      it('logs a safe error message', async () => {
        await service.sendPasswordResetEmail(
          'user@clinic.com',
          'raw-token-xyz',
        );

        expect(errorSpy).toHaveBeenCalledTimes(1);
        const errorMessage: string = errorSpy.mock.calls[0][0];
        expect(errorMessage).toContain('validation_error');
        expect(errorMessage).toContain('Invalid from address');
      });

      it('does not log the raw token on error', async () => {
        await service.sendPasswordResetEmail(
          'user@clinic.com',
          'raw-token-xyz',
        );

        const allLogs = [
          ...logSpy.mock.calls,
          ...warnSpy.mock.calls,
          ...errorSpy.mock.calls,
        ]
          .flat()
          .join(' ');

        expect(allLogs).not.toContain('raw-token-xyz');
      });
    });

    describe('when emails.send throws a network error', () => {
      beforeEach(() => {
        mockSend.mockRejectedValue(new Error('fetch failed'));
      });

      it('does not throw', async () => {
        await expect(
          service.sendPasswordResetEmail('user@clinic.com', 'raw-token-xyz'),
        ).resolves.toBeUndefined();
      });

      it('logs the error message safely', async () => {
        await service.sendPasswordResetEmail(
          'user@clinic.com',
          'raw-token-xyz',
        );

        expect(errorSpy).toHaveBeenCalledTimes(1);
        const errorMessage: string = errorSpy.mock.calls[0][0];
        expect(errorMessage).toContain('fetch failed');
      });

      it('does not log the raw token on network failure', async () => {
        await service.sendPasswordResetEmail(
          'user@clinic.com',
          'raw-token-xyz',
        );

        const allLogs = [
          ...logSpy.mock.calls,
          ...warnSpy.mock.calls,
          ...errorSpy.mock.calls,
        ]
          .flat()
          .join(' ');

        expect(allLogs).not.toContain('raw-token-xyz');
      });
    });

    describe('when MAIL_FROM is not set', () => {
      beforeEach(() => {
        delete process.env.MAIL_FROM;
      });

      it('logs a warning and does not throw', async () => {
        await expect(
          service.sendPasswordResetEmail('user@clinic.com', 'raw-token-xyz'),
        ).resolves.toBeUndefined();

        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toContain('MAIL_FROM');
      });

      it('does not call emails.send', async () => {
        await service.sendPasswordResetEmail(
          'user@clinic.com',
          'raw-token-xyz',
        );

        expect(mockSend).not.toHaveBeenCalled();
      });
    });
  });
});
