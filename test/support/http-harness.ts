import { INestApplication, RequestMethod, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import type { UserRole } from '@prisma/client';
import express from 'express';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { authConfig } from '../../src/config/auth.config';
import { appConfig } from '../../src/config/app.config';
import { BillingService } from '../../src/modules/billing/billing.service';
import { PlanCapabilitiesService } from '../../src/modules/billing/plan-capabilities.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createPrismaMock, PrismaMock } from './prisma-mock';

export type TestUser = {
  id: string;
  clinicId: string | null;
  role: UserRole;
  tokenVersion?: number;
  isActive?: boolean;
  deletedAt?: Date | null;
};

export type Harness = {
  app: INestApplication;
  prisma: PrismaMock;
  /** Registers a user so JwtStrategy can resolve it, and returns its bearer token. */
  tokenFor(user: TestUser): string;
  /** Signs a token WITHOUT registering the user (simulates a stale/unknown subject). */
  signRaw(payload: Record<string, unknown>, options?: { expiresIn?: string }): string;
  /** Controls `prisma.user.findUnique` for non-authentication lookups. */
  onUserFindUnique(impl: (args: any) => unknown): void;
  /** Bypasses billing/plan gating (on by default; disable to test the gates). */
  setBillingAllowed(allowed: boolean): void;
  get(path: string): request.Test;
  post(path: string): request.Test;
  patch(path: string): request.Test;
  put(path: string): request.Test;
  del(path: string): request.Test;
  close(): Promise<void>;
};

const PREFIX = appConfig.apiPrefix;

export function apiPath(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `/${PREFIX}${normalized}`;
}

/**
 * Boots the real AppModule over HTTP with the database replaced by an
 * in-memory Prisma mock. Global guards (JWT → tenant → roles → billing →
 * plan-feature), the global ValidationPipe, the global exception filter and
 * real controller routing all execute exactly as in production.
 */
export async function createHarness(
  options: { throttling?: boolean } = {},
): Promise<Harness> {
  const prisma = createPrismaMock();

  // ThrottlerGuard is registered as an APP_GUARD, which `overrideGuard` does
  // not reach. Patch the prototype instead so suites that fan out over many
  // routes cannot trip per-route limits (dictation allows 3 req/min) and turn
  // an authorization assertion into a spurious 429. Dedicated throttling tests
  // opt back in with `{ throttling: true }`.
  const throttleSpy = options.throttling
    ? null
    : jest
        .spyOn(ThrottlerGuard.prototype, 'canActivate')
        .mockResolvedValue(true);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .compile();

  const app = moduleRef.createNestApplication({
    rawBody: true,
    bodyParser: false,
    // Handlers are deliberately exercised into their error paths here; the
    // GlobalExceptionFilter's logging is covered by its own spec, and leaving
    // it on buries test results under hundreds of stack traces.
    logger: false,
  });

  app.use(express.json({ limit: '6mb', verify: (req: any, _res, buf: Buffer) => {
    if (Buffer.isBuffer(buf)) req.rawBody = buf;
  } }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));

  app.setGlobalPrefix(PREFIX, {
    exclude: [{ path: 'webhooks/whatsapp', method: RequestMethod.ALL }],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await app.init();

  // ── Authentication wiring ───────────────────────────────────────────────────
  const registry = new Map<string, Required<TestUser>>();
  let userFindUniqueImpl: (args: any) => unknown = () => null;

  prisma.user.findUnique.mockImplementation((args: any) => {
    // JwtStrategy is the only caller selecting tokenVersion — route it to the
    // registry so the strategy's own isActive/deletedAt/tokenVersion checks run.
    if (args?.select?.tokenVersion === true) {
      const found = registry.get(args?.where?.id);
      return Promise.resolve(found ?? null);
    }
    return Promise.resolve(userFindUniqueImpl(args));
  });

  const jwt = new JwtService({ secret: authConfig.jwtSecret });

  const billing = app.get(BillingService, { strict: false });
  const planCapabilities = app.get(PlanCapabilitiesService, { strict: false });
  let billingAllowed = true;

  jest
    .spyOn(billing, 'getCurrentSubscriptionStatus')
    .mockImplementation(async () =>
      billingAllowed
        ? ({ accessAllowed: true, status: 'ACTIVE' } as any)
        : ({
            accessAllowed: false,
            status: 'CANCELED',
            requiresPlanSelection: true,
            requiresPayment: false,
            message: 'Escolha um plano para continuar.',
          } as any),
    );
  jest.spyOn(planCapabilities, 'assertFeature').mockResolvedValue(undefined as any);

  const server = () => app.getHttpServer();

  return {
    app,
    prisma,
    tokenFor(user) {
      const full: Required<TestUser> = {
        tokenVersion: 0,
        isActive: true,
        deletedAt: null,
        ...user,
      } as Required<TestUser>;
      registry.set(full.id, full);
      return jwt.sign({
        sub: full.id,
        clinicId: full.clinicId,
        role: full.role,
        tokenVersion: full.tokenVersion,
      });
    },
    signRaw(payload, options) {
      return jwt.sign(payload, options as any);
    },
    onUserFindUnique(impl) {
      userFindUniqueImpl = impl;
    },
    setBillingAllowed(allowed) {
      billingAllowed = allowed;
    },
    get: (path) => request(server()).get(apiPath(path)),
    post: (path) => request(server()).post(apiPath(path)),
    patch: (path) => request(server()).patch(apiPath(path)),
    put: (path) => request(server()).put(apiPath(path)),
    del: (path) => request(server()).delete(apiPath(path)),
    close: async () => {
      throttleSpy?.mockRestore();
      await app.close();
    },
  };
}

// ── Canonical test principals ────────────────────────────────────────────────

export const CLINIC_A = 'clinic-aaaaaaaa';
export const CLINIC_B = 'clinic-bbbbbbbb';

export const USERS = {
  admin: { id: 'user-admin', clinicId: null, role: 'ADMIN' as UserRole },
  ownerA: { id: 'user-owner-a', clinicId: CLINIC_A, role: 'OWNER' as UserRole },
  dentistA: { id: 'user-dentist-a', clinicId: CLINIC_A, role: 'DENTIST' as UserRole },
  assistantA: { id: 'user-assistant-a', clinicId: CLINIC_A, role: 'ASSISTANT' as UserRole },
  ownerB: { id: 'user-owner-b', clinicId: CLINIC_B, role: 'OWNER' as UserRole },
  dentistB: { id: 'user-dentist-b', clinicId: CLINIC_B, role: 'DENTIST' as UserRole },
} satisfies Record<string, TestUser>;
