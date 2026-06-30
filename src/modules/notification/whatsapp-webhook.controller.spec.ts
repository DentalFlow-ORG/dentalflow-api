import { INestApplication, Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../../prisma/prisma.service';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller';
import { WhatsAppWebhookService } from './whatsapp-webhook.service';

describe('WhatsAppWebhookController', () => {
  let app: INestApplication<App>;
  const originalVerifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  const originalAppSecret = process.env.WHATSAPP_APP_SECRET;
  const prismaMock = {
    notificationMessage: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };

  beforeAll(async () => {
    process.env.WHATSAPP_VERIFY_TOKEN = 'test-verify-token';
    delete process.env.WHATSAPP_APP_SECRET;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [WhatsAppWebhookController],
      providers: [
        WhatsAppWebhookService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (originalVerifyToken === undefined) {
      delete process.env.WHATSAPP_VERIFY_TOKEN;
    } else {
      process.env.WHATSAPP_VERIFY_TOKEN = originalVerifyToken;
    }

    if (originalAppSecret === undefined) {
      delete process.env.WHATSAPP_APP_SECRET;
    } else {
      process.env.WHATSAPP_APP_SECRET = originalAppSecret;
    }

    await app.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('verifies the webhook with the correct token and returns the challenge', () => {
    return request(app.getHttpServer())
      .get('/webhooks/whatsapp')
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'test-verify-token',
        'hub.challenge': 'meta-challenge',
      })
      .expect(200)
      .expect('Content-Type', /text\/plain/)
      .expect('meta-challenge');
  });

  it('rejects webhook verification with the wrong token', () => {
    return request(app.getHttpServer())
      .get('/webhooks/whatsapp')
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong-token',
        'hub.challenge': 'meta-challenge',
      })
      .expect(403);
  });

  it('rejects webhook verification with a missing or invalid mode', async () => {
    await request(app.getHttpServer())
      .get('/webhooks/whatsapp')
      .query({
        'hub.verify_token': 'test-verify-token',
        'hub.challenge': 'meta-challenge',
      })
      .expect(403);

    await request(app.getHttpServer())
      .get('/webhooks/whatsapp')
      .query({
        'hub.mode': 'invalid',
        'hub.verify_token': 'test-verify-token',
        'hub.challenge': 'meta-challenge',
      })
      .expect(403);
  });

  it('logs only safe aggregate metadata for a status payload', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();

    await request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .send({
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: '123456789' },
                  statuses: [
                    {
                      id: 'wamid.status-example',
                      status: 'delivered',
                      timestamp: '1710000000',
                      recipient_id: '5511999999999',
                    },
                  ],
                },
              },
            ],
          },
        ],
      })
      .expect(200)
      .expect({ status: 'ok' });

    const receiptLog = logSpy.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.startsWith('WhatsApp webhook received:'));

    expect(receiptLog).toEqual(
      expect.stringContaining(
        'object=whatsapp_business_account entries=1 fields=messages statuses=1 messages=0 statusValues=delivered',
      ),
    );
    expect(receiptLog).not.toContain('5511999999999');
    expect(receiptLog).not.toContain('wamid.status-example');
  });

  it('logs sanitized failure metadata and still returns ok', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    await request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .send({
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  statuses: [
                    {
                      id: 'wamid.failed-status-example',
                      status: 'failed',
                      recipient_id: '5511999999999',
                      errors: [
                        {
                          code: 131030,
                          title: 'Recipient phone number not in allowed list',
                          message:
                            'Recipient +55 11 99999-9999 is not in the allowed list',
                          error_data: {
                            details:
                              'Add +5511999999999 to the allowed list before sending',
                          },
                          href: 'https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes?token=secret',
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        ],
      })
      .expect(200)
      .expect({ status: 'ok' });

    const failureLog = warnSpy.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.startsWith('WhatsApp webhook failed status:'));

    expect(failureLog).toEqual(expect.stringContaining('code=131030'));
    expect(failureLog).toEqual(
      expect.stringContaining(
        'title="Recipient phone number not in allowed list"',
      ),
    );
    expect(failureLog).toEqual(expect.stringContaining('[redacted]'));
    expect(failureLog).toEqual(
      expect.stringContaining(
        'href="https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes"',
      ),
    );
    expect(failureLog).not.toContain('5511999999999');
    expect(failureLog).not.toContain('wamid.failed-status-example');
    expect(failureLog).not.toContain('token=secret');
  });

  it('logs when a failed status has no error metadata', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    await request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .send({
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: { statuses: [{ status: 'failed' }] },
              },
            ],
          },
        ],
      })
      .expect(200)
      .expect({ status: 'ok' });

    expect(warnSpy).toHaveBeenCalledWith(
      'WhatsApp webhook failed status: no error metadata',
    );
  });

  it('accepts a realistic incoming WhatsApp message payload', () => {
    return request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .send({
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  contacts: [{ wa_id: '5511999999999' }],
                  messages: [
                    {
                      from: '5511999999999',
                      id: 'wamid.message-example',
                      type: 'text',
                      text: { body: 'Example message' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      })
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('accepts an unknown payload shape without crashing', () => {
    return request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .send({ unexpected: { nested: true } })
      .expect(200)
      .expect({ status: 'ok' });
  });
});
