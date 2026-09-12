import type { UserRole } from '@prisma/client';

import {
  apiPath,
  createHarness,
  Harness,
} from '../../../test/support/http-harness';
import { ROUTE_ACCESS_MATRIX } from '../../../test/support/route-access-matrix';

/**
 * TENANT SCOPING
 * ==============
 *
 * Drives every tenant-scoped route as a member of one clinic and inspects the
 * Prisma queries the handler actually issued. Each query must carry that
 * clinic's id somewhere in its arguments — the predicate that keeps one
 * clinic's rows out of another's responses.
 *
 * This catches the failure mode that is invisible to a response-shape
 * assertion: a `findFirst({ where: { id } })` with no `clinicId`, which looks
 * correct against a single-tenant fixture and leaks across tenants in
 * production.
 *
 * Queries that are legitimately un-scoped are enumerated below with the reason
 * each one is safe. Anything else fails.
 */

const CLINIC = 'clinic-tenant-scoping-probe';
const PARAM_STUB = '00000000-0000-4000-8000-000000000000';

/**
 * Queries that carry no clinic predicate by design.
 * Keyed `model.operation`, each with the invariant that makes it safe.
 */
const UNSCOPED_BY_DESIGN: Record<string, string> = {
  // Subscription plans are a platform-wide catalogue with no clinicId column.
  'plan.findMany': 'global plan catalogue, no tenant column',
  // WhatsApp templates are a platform-wide catalogue with no clinicId column.
  'notificationTemplate.findMany':
    'global template catalogue, no tenant column',
  'notificationTemplate.findUnique':
    'global template catalogue, no tenant column',
  // Read-then-verify: the row is fetched by primary key and the handler
  // compares `consent.clinicId` before mutating, answering 404 (not 403) on a
  // mismatch so a foreign id is indistinguishable from a missing one.
  'notificationConsent.findUnique': 'read-then-verify against caller clinicId',
  // The published-profile slug route is @Public by design — it is the clinic's
  // own public page and is intentionally reachable across tenants.
  'profile.findUnique': 'public published-profile lookup by slug',
};

function deepContains(value: unknown, needle: string, depth = 0): boolean {
  if (depth > 10) return false;
  if (typeof value === 'string') return value === needle;
  if (Array.isArray(value))
    return value.some((v) => deepContains(v, needle, depth + 1));
  if (value && typeof value === 'object') {
    return Object.values(value).some((v) => deepContains(v, needle, depth + 1));
  }
  return false;
}

describe('Tenant scoping (every tenant-scoped route)', () => {
  let harness: Harness;
  let fetchSpy: jest.SpyInstance;

  const tenantRoutes = ROUTE_ACCESS_MATRIX.filter(
    ([method, , , flags]) =>
      flags.includes('tenant') &&
      ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method),
  );

  beforeAll(async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('network disabled in tenant scoping tests'));
    harness = await createHarness();
  }, 120_000);

  afterAll(async () => {
    fetchSpy.mockRestore();
    await harness.close();
  });

  it.each(['OWNER', 'DENTIST', 'ASSISTANT'] as const)(
    'issues no un-scoped query for any route reachable as %s',
    async (role: UserRole) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const request = require('supertest') as typeof import('supertest');
      const token = harness.tokenFor({
        id: `tenant-probe-${role}`,
        clinicId: CLINIC,
        role,
      });

      const violations: string[] = [];
      let probed = 0;

      for (const [method, path] of tenantRoutes) {
        harness.prisma.__reset();

        const verb = method.toLowerCase() as 'get';
        const res = await request(harness.app.getHttpServer())
          [verb](apiPath(path.replace(/:[A-Za-z0-9_]+/g, PARAM_STUB)))
          .set('Authorization', `Bearer ${token}`)
          .send({});

        const queries = harness.prisma
          .__calls()
          // The authentication lookup is keyed by user id, not clinic.
          .filter((c) => !(c.model === 'user' && c.operation === 'findUnique'));

        if (queries.length === 0) continue;
        probed += 1;

        for (const query of queries) {
          if (deepContains(query.args, CLINIC)) continue;
          const key = `${query.model}.${query.operation}`;
          if (key in UNSCOPED_BY_DESIGN) continue;
          violations.push(`${method} ${path} [${res.status}] -> ${key}`);
        }
      }

      expect(violations).toEqual([]);
      // Guards against the probe silently going quiet: if handlers start
      // failing before they query, this drops and the suite says so.
      expect(probed).toBeGreaterThan(0);
    },
    300_000,
  );

  it('keeps every un-scoped query justified', () => {
    // Documentation-as-test: each exemption must state why it is safe.
    for (const [key, reason] of Object.entries(UNSCOPED_BY_DESIGN)) {
      expect(`${key}: ${reason}`.length).toBeGreaterThan(key.length + 2);
    }
    expect(Object.keys(UNSCOPED_BY_DESIGN).sort()).toEqual([
      'notificationConsent.findUnique',
      'notificationTemplate.findMany',
      'notificationTemplate.findUnique',
      'plan.findMany',
      'profile.findUnique',
    ]);
  });
});
