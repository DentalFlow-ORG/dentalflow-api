import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'node:crypto';

import { WhatsAppWebhookService } from './whatsapp-webhook.service';

/**
 * The WhatsApp Cloud API webhook.
 *
 * This is a public, unauthenticated endpoint — Meta calls it, so there is no
 * token and no tenant. Everything protecting it is in this service: the
 * verification handshake and the HMAC over the raw body. Both were untested.
 *
 * The signature check has a deliberate escape hatch: with no app secret
 * configured it accepts anything, so the integration can be developed before
 * the secret exists. That is defensible and it is also exactly the kind of
 * thing that quietly ships to production, so it is pinned here rather than
 * left implicit.
 */

const APP_SECRET = 'meta-app-secret';
const VERIFY_TOKEN = 'meta-verify-token';

function sign(body: Buffer, secret = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** A status callback in the shape Meta actually posts. */
function statusPayload(status: Record<string, unknown>) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { statuses: [status] } }] }],
  };
}

describe('WhatsAppWebhookService', () => {
  const originalSecret = process.env.WHATSAPP_APP_SECRET;
  const originalWebhookSecret = process.env.WHATSAPP_WEBHOOK_APP_SECRET;
  const originalVerify = process.env.WHATSAPP_VERIFY_TOKEN;

  let prisma: { notificationMessage: { updateMany: jest.Mock } };
  let service: WhatsAppWebhookService;

  beforeEach(() => {
    delete process.env.WHATSAPP_APP_SECRET;
    delete process.env.WHATSAPP_WEBHOOK_APP_SECRET;
    process.env.WHATSAPP_VERIFY_TOKEN = VERIFY_TOKEN;

    prisma = {
      notificationMessage: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    service = new WhatsAppWebhookService(prisma as never);

    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env.WHATSAPP_APP_SECRET = originalSecret;
    process.env.WHATSAPP_WEBHOOK_APP_SECRET = originalWebhookSecret;
    process.env.WHATSAPP_VERIFY_TOKEN = originalVerify;
    if (originalSecret === undefined) delete process.env.WHATSAPP_APP_SECRET;
    if (originalWebhookSecret === undefined) {
      delete process.env.WHATSAPP_WEBHOOK_APP_SECRET;
    }
  });

  // ── The subscription handshake ─────────────────────────────────────────────

  describe('verify', () => {
    it('echoes the challenge for a correct subscription request', () => {
      expect(service.verify('subscribe', VERIFY_TOKEN, 'challenge-1')).toBe(
        'challenge-1',
      );
    });

    it('refuses a wrong token', () => {
      expect(() => service.verify('subscribe', 'wrong', 'c')).toThrow(
        ForbiddenException,
      );
    });

    it('refuses a token of a different length', () => {
      // The comparison is constant-time and must not throw on a length
      // mismatch before it gets there.
      expect(() => service.verify('subscribe', 'short', 'c')).toThrow(
        ForbiddenException,
      );
    });

    it('refuses a mode other than subscribe', () => {
      expect(() => service.verify('unsubscribe', VERIFY_TOKEN, 'c')).toThrow(
        ForbiddenException,
      );
    });

    it('refuses a request with no challenge to echo', () => {
      expect(() =>
        service.verify('subscribe', VERIFY_TOKEN, undefined),
      ).toThrow(ForbiddenException);
    });

    it('refuses everything when no verify token is configured', () => {
      delete process.env.WHATSAPP_VERIFY_TOKEN;

      expect(() => service.verify('subscribe', 'anything', 'c')).toThrow(
        ForbiddenException,
      );
    });
  });

  // ── The signature over the raw body ────────────────────────────────────────

  describe('the request signature', () => {
    const body = Buffer.from(JSON.stringify(statusPayload({ id: 'wamid.1' })));

    it('accepts a correctly signed request', () => {
      process.env.WHATSAPP_APP_SECRET = APP_SECRET;

      expect(() =>
        service.receive(JSON.parse(body.toString()), body, sign(body)),
      ).not.toThrow();
    });

    it('refuses a signature made with the wrong secret', () => {
      process.env.WHATSAPP_APP_SECRET = APP_SECRET;

      expect(() =>
        service.receive(
          JSON.parse(body.toString()),
          body,
          sign(body, 'not-the-secret'),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('refuses a signature for a different body', () => {
      process.env.WHATSAPP_APP_SECRET = APP_SECRET;
      const other = Buffer.from('{"object":"tampered"}');

      // The HMAC is over the raw bytes, so a body edited in flight no longer
      // matches even though the signature is well formed.
      expect(() =>
        service.receive(JSON.parse(body.toString()), body, sign(other)),
      ).toThrow(UnauthorizedException);
    });

    it('refuses a request carrying no signature', () => {
      process.env.WHATSAPP_APP_SECRET = APP_SECRET;

      expect(() =>
        service.receive(JSON.parse(body.toString()), body, undefined),
      ).toThrow(UnauthorizedException);
    });

    it('refuses a request whose raw body was not captured', () => {
      process.env.WHATSAPP_APP_SECRET = APP_SECRET;

      // Without the raw bytes there is nothing to verify, so it must fail
      // closed rather than skip the check.
      expect(() =>
        service.receive(JSON.parse(body.toString()), undefined, sign(body)),
      ).toThrow(UnauthorizedException);
    });

    it('reads the secret from either configured variable', () => {
      process.env.WHATSAPP_WEBHOOK_APP_SECRET = APP_SECRET;

      expect(() =>
        service.receive(JSON.parse(body.toString()), body, sign(body)),
      ).not.toThrow();
      expect(() =>
        service.receive(JSON.parse(body.toString()), body, 'sha256=bogus'),
      ).toThrow(UnauthorizedException);
    });

    it('accepts an unsigned request when no secret is configured', () => {
      // Deliberate: the integration can be built before the secret exists.
      // Pinned so the trade-off is visible rather than discovered.
      expect(() =>
        service.receive(JSON.parse(body.toString()), undefined, undefined),
      ).not.toThrow();
    });
  });

  // ── Delivery status callbacks ──────────────────────────────────────────────

  describe('status callbacks', () => {
    /** Runs a callback and returns the update written, if any. */
    async function deliver(status: Record<string, unknown>) {
      await service.receive(statusPayload(status), undefined, undefined);
      return prisma.notificationMessage.updateMany.mock.calls[0]?.[0] as
        | { where: { providerRef: string }; data: Record<string, unknown> }
        | undefined;
    }

    it('marks a message sent', async () => {
      const call = await deliver({
        id: 'wamid.1',
        status: 'sent',
        timestamp: '1781000000',
      });

      expect(call?.where).toEqual({ providerRef: 'wamid.1' });
      expect(call?.data).toMatchObject({ status: 'SENT' });
      expect((call?.data.sentAt as Date).toISOString()).toBe(
        new Date(1781000000 * 1000).toISOString(),
      );
    });

    it('marks a message delivered', async () => {
      const call = await deliver({ id: 'wamid.1', status: 'delivered' });

      expect(call?.data).toMatchObject({ status: 'DELIVERED' });
      expect(call?.data.deliveredAt).toBeInstanceOf(Date);
    });

    it('marks a message read', async () => {
      const call = await deliver({ id: 'wamid.1', status: 'read' });

      expect(call?.data).toMatchObject({ status: 'READ' });
    });

    it('records why a message failed', async () => {
      const call = await deliver({
        id: 'wamid.1',
        status: 'failed',
        errors: [{ title: 'Recipient not opted in' }],
      });

      expect(call?.data).toMatchObject({
        status: 'FAILED',
        failReason: 'Recipient not opted in',
      });
    });

    it('falls back to the error message, then to a default reason', async () => {
      const withMessage = await deliver({
        id: 'wamid.1',
        status: 'failed',
        errors: [{ message: 'Rate limited' }],
      });
      expect(withMessage?.data.failReason).toBe('Rate limited');

      prisma.notificationMessage.updateMany.mockClear();
      const withNothing = await deliver({ id: 'wamid.2', status: 'failed' });
      expect(withNothing?.data.failReason).toBe(
        'Falha reportada pelo WhatsApp Cloud API',
      );
    });

    it('matches the message by the provider reference, never by phone', async () => {
      const call = await deliver({ id: 'wamid.1', status: 'sent' });

      // A phone number is not unique to a message; the provider ref is.
      expect(call?.where).toEqual({ providerRef: 'wamid.1' });
    });

    it('ignores a callback with no message id', async () => {
      await deliver({ status: 'sent' });

      expect(prisma.notificationMessage.updateMany).not.toHaveBeenCalled();
    });

    it('ignores a status it does not model', async () => {
      await deliver({ id: 'wamid.1', status: 'deleted' });

      expect(prisma.notificationMessage.updateMany).not.toHaveBeenCalled();
    });

    it('ignores a callback whose timestamp is not a number', async () => {
      await deliver({ id: 'wamid.1', status: 'sent', timestamp: 'not-a-time' });

      expect(prisma.notificationMessage.updateMany).not.toHaveBeenCalled();
    });

    it('survives a payload that is not shaped like a callback at all', () => {
      expect(() => service.receive(null, undefined, undefined)).not.toThrow();
      expect(() =>
        service.receive({ entry: 'nonsense' }, undefined, undefined),
      ).not.toThrow();
      expect(prisma.notificationMessage.updateMany).not.toHaveBeenCalled();
    });

    it('rejects a failed write so Meta can retry delivery', async () => {
      prisma.notificationMessage.updateMany.mockRejectedValue(
        new Error('connection lost'),
      );
      await expect(
        service.receive(statusPayload({ id: 'wamid.1', status: 'sent' })),
      ).rejects.toThrow('connection lost');
    });
  });
});
