import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';

import { AppModule } from './../src/app.module';
import {
  NEST_APP_OPTIONS,
  configureApp,
} from './../src/bootstrap/configure-app';
import { appConfig } from './../src/config/app.config';
import { PrismaService } from './../src/prisma/prisma.service';
import { TEST_PASSWORD, createClinic, createUser } from './support/factories';

/**
 * End-to-end: the application as `main.ts` builds it.
 *
 * The distinction from the integration suite is the layer under test. Those
 * tests go through controllers to prove database behaviour; these prove the
 * *bootstrap* — the security headers, the CORS policy, the two body-size
 * limits, the route prefix and its webhook exclusion, and the global
 * validation pipe. All of that used to live inline in `main.ts`, where
 * nothing could reach it, and all of it is behaviour a client depends on.
 *
 * It runs against the disposable database (`bun run test:db:up`);
 * `jest-e2e-setup.ts` refuses to start otherwise.
 */
describe('Application bootstrap (e2e)', () => {
  const prefix = appConfig.apiPrefix;
  const ALLOWED_ORIGIN = 'http://localhost:5173';

  let app: INestApplication;
  let prisma: PrismaClient;
  let server: () => ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({
      ...NEST_APP_OPTIONS,
      logger: false,
    });
    configureApp(app);
    await app.init();
    await app.listen(0);

    prisma = app.get(PrismaService);
    server = () => app.getHttpServer();
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  it('assigns a server-generated request ID to success and error responses', async () => {
    const ok = await request(server())
      .get(`/${prefix}/health`)
      .set('X-Request-ID', 'untrusted');
    const error = await request(server())
      .get(`/${prefix}/patients`)
      .set('Origin', ALLOWED_ORIGIN);
    expect(ok.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(error.headers['x-request-id']).not.toBe(ok.headers['x-request-id']);
    expect(error.body.requestId).toBe(error.headers['x-request-id']);
    expect(error.headers['access-control-expose-headers']).toContain(
      'X-Request-ID',
    );
  });

  // ── Security headers ───────────────────────────────────────────────────────

  describe('security headers', () => {
    it('sends the helmet headers on a real response', async () => {
      const res = await request(server()).get(`/${prefix}/health`);

      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['content-security-policy']).toContain(
        "default-src 'none'",
      );
      expect(res.headers['content-security-policy']).toContain(
        "frame-ancestors 'none'",
      );
    });

    it('does not advertise the server framework', async () => {
      const res = await request(server()).get(`/${prefix}/health`);

      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('marks responses no-store so no cache can retain them', async () => {
      const res = await request(server()).get(`/${prefix}/health`);

      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('withholds HSTS outside production, where it would pin plain HTTP clients', async () => {
      const res = await request(server()).get(`/${prefix}/health`);

      expect(res.headers['strict-transport-security']).toBeUndefined();
    });

    it('sends them on an error response too, not only a successful one', async () => {
      const res = await request(server()).get(`/${prefix}/patients`);

      expect(res.status).toBe(401);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });
  });

  // ── CORS ───────────────────────────────────────────────────────────────────

  describe('CORS', () => {
    it('allows the configured frontend origin', async () => {
      const res = await request(server())
        .get(`/${prefix}/health`)
        .set('Origin', ALLOWED_ORIGIN);

      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('refuses an origin that is not configured', async () => {
      const res = await request(server())
        .get(`/${prefix}/health`)
        .set('Origin', 'https://attacker.example');

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      // Denied cleanly: the browser blocks it for lack of the ACAO header, and
      // the server does not turn a rejected origin into a 500.
      expect(res.status).not.toBe(500);
    });

    it('allows a request with no Origin at all, such as a health probe', async () => {
      await request(server()).get(`/${prefix}/health`).expect(200);
    });

    it('answers a preflight with the methods and headers the frontend needs', async () => {
      const res = await request(server())
        .options(`/${prefix}/appointments`)
        .set('Origin', ALLOWED_ORIGIN)
        .set('Access-Control-Request-Method', 'POST');

      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
      expect(res.headers['access-control-allow-methods']).toContain('PATCH');
      expect(res.headers['access-control-allow-headers']).toContain(
        'Authorization',
      );
    });
  });

  // ── Route prefix ───────────────────────────────────────────────────────────

  describe('route prefix', () => {
    it(`serves the API under /${prefix}`, async () => {
      const res = await request(server()).get(`/${prefix}/health`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('status');
    });

    it('does not serve the same route without the prefix', async () => {
      await request(server()).get('/health').expect(404);
    });

    it('exempts the WhatsApp webhook, which Meta calls at a fixed path', async () => {
      // Meta will not send a prefix, so this route has to answer where the
      // provider actually calls it — and nowhere else.
      const res = await request(server())
        .get('/webhooks/whatsapp')
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong' });

      expect(res.status).not.toBe(404);

      await request(server()).get(`/${prefix}/webhooks/whatsapp`).expect(404);
    });

    it('answers 404 for a route that does not exist', async () => {
      await request(server()).get(`/${prefix}/no-such-route`).expect(404);
    });
  });

  // ── Body size limits ───────────────────────────────────────────────────────

  describe('body size limits', () => {
    it('rejects a body over the 100 kB limit', async () => {
      const oversized = { email: 'a'.repeat(200_000), password: 'x' };

      const res = await request(server())
        .post(`/${prefix}/auth/login`)
        .send(oversized);

      expect(res.status).toBe(413);
    });

    it('still sends the CORS header on that rejection', async () => {
      // The reason CORS is registered before the body parsers: without the
      // header the browser reports a generic CORS failure and the frontend
      // never sees the 413 it needs to explain to the user.
      const res = await request(server())
        .post(`/${prefix}/auth/login`)
        .set('Origin', ALLOWED_ORIGIN)
        .send({ email: 'a'.repeat(200_000), password: 'x' });

      expect(res.status).toBe(413);
      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    });

    it('accepts a body comfortably under the limit', async () => {
      const res = await request(server())
        .post(`/${prefix}/auth/login`)
        .send({ email: 'nobody@example.test', password: 'wrong-password' });

      expect(res.status).toBe(401);
    });
  });

  // ── Global validation pipe ─────────────────────────────────────────────────

  describe('validation pipe', () => {
    it('rejects a request missing required fields', async () => {
      await request(server())
        .post(`/${prefix}/auth/login`)
        .send({})
        .expect(400);
    });

    it('rejects a property the DTO does not declare', async () => {
      const res = await request(server()).post(`/${prefix}/auth/login`).send({
        email: 'someone@example.test',
        password: TEST_PASSWORD,
        role: 'ADMIN',
      });

      expect(res.status).toBe(400);
    });

    it('describes what was wrong rather than returning a bare 400', async () => {
      const res = await request(server())
        .post(`/${prefix}/auth/login`)
        .send({ email: 'not-an-email', password: '' });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/email/i);
    });
  });

  // ── Authentication, end to end against the real database ───────────────────

  describe('authentication', () => {
    const EMAIL = 'e2e-owner@example.test';

    beforeAll(async () => {
      await createClinic(prisma, { id: 'clinic-e2e', name: 'Clínica E2E' });
      await createUser(prisma, {
        id: 'user-e2e',
        clinicId: 'clinic-e2e',
        role: 'OWNER',
        email: EMAIL,
      });
    });

    afterAll(async () => {
      await prisma.user.deleteMany({ where: { id: 'user-e2e' } });
      await prisma.clinic.deleteMany({ where: { id: 'clinic-e2e' } });
    });

    it('refuses a protected route without a token', async () => {
      await request(server()).get(`/${prefix}/auth/me`).expect(401);
    });

    it('refuses a protected route with a token it did not sign', async () => {
      await request(server())
        .get(`/${prefix}/auth/me`)
        .set('Authorization', 'Bearer not-a-real-token')
        .expect(401);
    });

    it('refuses the right password against the wrong email', async () => {
      await request(server())
        .post(`/${prefix}/auth/login`)
        .send({ email: 'someone-else@example.test', password: TEST_PASSWORD })
        .expect(401);
    });

    it('refuses the wrong password against a real account', async () => {
      await request(server())
        .post(`/${prefix}/auth/login`)
        .send({ email: EMAIL, password: 'not-the-password' })
        .expect(401);
    });

    it('issues a token for valid credentials and accepts it on the next request', async () => {
      const login = await request(server())
        .post(`/${prefix}/auth/login`)
        .send({ email: EMAIL, password: TEST_PASSWORD });

      expect(login.status).toBe(200);
      expect(typeof login.body.accessToken).toBe('string');

      const me = await request(server())
        .get(`/${prefix}/auth/me`)
        .set('Authorization', `Bearer ${login.body.accessToken}`);

      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({ email: EMAIL, clinicId: 'clinic-e2e' });
    });

    it('never returns the password hash with the user', async () => {
      const login = await request(server())
        .post(`/${prefix}/auth/login`)
        .send({ email: EMAIL, password: TEST_PASSWORD });

      const body = JSON.stringify(login.body);
      expect(body).not.toMatch(/passwordHash/i);
      expect(body).not.toMatch(/\$2[aby]\$/); // a bcrypt hash
    });
  });
});
