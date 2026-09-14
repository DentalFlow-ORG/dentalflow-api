import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import type { PrismaClient, UserRole } from '@prisma/client';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import {
  NEST_APP_OPTIONS,
  configureApp,
} from '../../src/bootstrap/configure-app';
import { appConfig } from '../../src/config/app.config';
import { authConfig } from '../../src/config/auth.config';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Boots the real application against the real disposable PostgreSQL.
 *
 * The difference from `http-harness.ts` is the whole point of this suite:
 * nothing is mocked below the controller. Prisma is the genuine client, so
 * unique constraints, foreign keys, cascades, transactions, `deletedAt`
 * filtering, ordering and timestamp semantics are exercised as PostgreSQL
 * actually implements them — none of which a mock can prove.
 *
 * Only two things are stubbed, and neither is under test: the throttler (so
 * request volume cannot turn an assertion into a 429) and outbound `fetch`
 * (so no test can reach Stripe, Google, OpenAI or Meta).
 */

const PREFIX = appConfig.apiPrefix;

export function apiPath(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `/${PREFIX}${normalized}`;
}

export type IntegrationHarness = {
  app: INestApplication;
  prisma: PrismaClient;
  /** Signs a token for a user that must already exist in the database. */
  tokenFor(user: {
    id: string;
    clinicId: string | null;
    role: UserRole;
    tokenVersion?: number;
  }): string;
  /** Deletes every row from every table, leaving the schema intact. */
  truncate(): Promise<void>;
  get(path: string): request.Test;
  post(path: string): request.Test;
  patch(path: string): request.Test;
  put(path: string): request.Test;
  del(path: string): request.Test;
  close(): Promise<void>;
};

let cachedTableNames: string[] | null = null;

async function tableNames(prisma: PrismaClient): Promise<string[]> {
  if (cachedTableNames) return cachedTableNames;

  const rows = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT LIKE '\\_prisma%'
  `;
  cachedTableNames = rows.map((row) => `"public"."${row.tablename}"`);
  return cachedTableNames;
}

export async function createIntegrationHarness(): Promise<IntegrationHarness> {
  const originalCanActivate = ThrottlerGuard.prototype.canActivate;
  ThrottlerGuard.prototype.canActivate = () => Promise.resolve(true);

  const fetchSpy = jest
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(
      new Error('Outbound network is disabled in integration tests.'),
    );

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication({
    ...NEST_APP_OPTIONS,
    logger: false,
  });

  // The same wiring main.ts applies: body-size limits, security headers, CORS
  // policy, route prefix and validation pipe. Reproducing it here by hand let
  // the harness drift from production; calling it means these tests run
  // against the request pipeline the deployed application actually has.
  configureApp(app);

  await app.init();
  // Bind once so Supertest reuses the port instead of opening one per request.
  await app.listen(0);

  const prisma = app.get(PrismaService);
  const jwt = new JwtService({ secret: authConfig.jwtSecret });
  const server = () => app.getHttpServer();

  return {
    app,
    prisma,

    tokenFor(user) {
      return jwt.sign({
        sub: user.id,
        clinicId: user.clinicId,
        role: user.role,
        tokenVersion: user.tokenVersion ?? 0,
      });
    },

    async truncate() {
      const tables = await tableNames(prisma);
      if (tables.length === 0) return;
      // One statement, CASCADE, so foreign keys never dictate an ordering and
      // every test starts from genuinely empty tables.
      await prisma.$executeRawUnsafe(
        `TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`,
      );
    },

    get: (path) => request(server()).get(apiPath(path)),
    post: (path) => request(server()).post(apiPath(path)),
    patch: (path) => request(server()).patch(apiPath(path)),
    put: (path) => request(server()).put(apiPath(path)),
    del: (path) => request(server()).delete(apiPath(path)),

    close: async () => {
      ThrottlerGuard.prototype.canActivate = originalCanActivate;
      fetchSpy.mockRestore();
      await app.close();
    },
  };
}
