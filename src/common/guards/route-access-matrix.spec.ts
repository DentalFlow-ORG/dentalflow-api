import { Reflector } from '@nestjs/core';
import type { UserRole } from '@prisma/client';

import { createHarness, Harness } from '../../../test/support/http-harness';
import { IS_ANY_AUTHENTICATED_KEY } from '../decorators/any-authenticated.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { REQUIRES_BILLING_ACCESS_KEY } from '../decorators/requires-billing-access.decorator';
import { REQUIRES_PLAN_FEATURE_KEY } from '../decorators/require-plan-feature.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { TENANT_SCOPED_KEY } from '../decorators/tenant-scoped.decorator';
import {
  Policy,
  RouteRow,
  ROUTE_ACCESS_MATRIX,
} from '../../../test/support/route-access-matrix';

/**
 * FROZEN ROLE-ACCESS MATRIX
 * =========================
 *
 * Every HTTP route in the application, with the access policy it declares.
 * This table is the authority for "who may call what"; the tests below compare
 * it against the policies the running Nest application actually reports.
 *
 * A new or changed endpoint fails this suite until its row is added or updated
 * here — which is the point. Editing a row is a deliberate statement that the
 * permission change was intended and reviewed. Widening a role set or dropping
 * a `tenant` flag without a matching product decision is a security regression.
 *
 * Columns: method, path, policy, flags
 *   policy: 'PUBLIC' | 'ANY_AUTHENTICATED' | the list of permitted roles
 *   flags:  'tenant'    — TenantGuard asserts clinic membership
 *           'billing'   — BillingAccessGuard requires subscription access
 *           'feature:X' — PlanFeatureGuard requires plan capability X
 */
const ALL_ROLES: UserRole[] = ['ADMIN', 'OWNER', 'DENTIST', 'ASSISTANT'];

function serialize(row: RouteRow): string {
  const [method, path, policy, flags] = row;
  const policyText = Array.isArray(policy) ? [...policy].sort().join('|') : policy;
  return `${method} ${path} :: ${policyText} :: ${[...flags].sort().join(',')}`;
}

describe('Role-access matrix (all HTTP routes)', () => {
  let harness: Harness;
  let live: RouteRow[];

  beforeAll(async () => {
    harness = await createHarness();
    const reflector = new Reflector();
    const rows: RouteRow[] = [];

    for (const [, module] of (harness.app as any).container.getModules()) {
      for (const [, wrapper] of module.controllers) {
        if (!wrapper.instance) continue;
        const prototype = Object.getPrototypeOf(wrapper.instance);
        const controllerPath = Reflect.getMetadata('path', wrapper.metatype) as string;

        for (const key of Object.getOwnPropertyNames(prototype)) {
          if (key === 'constructor') continue;
          const handler = prototype[key];
          const methodIndex = Reflect.getMetadata('method', handler) as number | undefined;
          if (methodIndex === undefined) continue;

          const rawPath = Reflect.getMetadata('path', handler) as string | string[];
          const paths: string[] = Array.isArray(rawPath) ? rawPath : [rawPath];
          const targets = [handler, wrapper.metatype];

          const isPublic = !!reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets);
          const anyAuth = !!reflector.getAllAndOverride<boolean>(
            IS_ANY_AUTHENTICATED_KEY,
            targets,
          );
          const roles = reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, targets) ?? null;
          const policy = (
            isPublic ? 'PUBLIC' : anyAuth ? 'ANY_AUTHENTICATED' : roles
          ) as Policy;

          const feature = reflector.getAllAndOverride<string>(
            REQUIRES_PLAN_FEATURE_KEY,
            targets,
          );
          const flags = [
            reflector.getAllAndOverride<boolean>(TENANT_SCOPED_KEY, targets) ? 'tenant' : null,
            reflector.getAllAndOverride<boolean>(REQUIRES_BILLING_ACCESS_KEY, targets)
              ? 'billing'
              : null,
            feature ? `feature:${feature}` : null,
          ].filter((flag): flag is string => flag !== null);

          for (const path of paths) {
            rows.push([
              ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'][
                methodIndex
              ],
              `/${controllerPath}/${path}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1'),
              policy,
              flags,
            ]);
          }
        }
      }
    }

    live = rows.sort((a, b) => `${a[1]} ${a[0]}`.localeCompare(`${b[1]} ${b[0]}`));
  }, 120_000);

  afterAll(async () => {
    await harness.close();
  });

  it('matches the frozen matrix exactly — update the table when an endpoint changes', () => {
    expect(live.map(serialize)).toEqual(ROUTE_ACCESS_MATRIX.map(serialize));
  });

  it('declares an explicit access policy on every route', () => {
    const undeclared = live
      .filter(
        ([, , policy]) =>
          policy !== 'PUBLIC' && policy !== 'ANY_AUTHENTICATED' && !Array.isArray(policy),
      )
      .map(([method, path]) => `${method} ${path}`);
    expect(undeclared).toEqual([]);
  });

  it('never grants a role outside the known role model', () => {
    const unknown = live
      .filter(([, , policy]) => Array.isArray(policy))
      .flatMap(([method, path, policy]) =>
        (policy as UserRole[])
          .filter((role) => !ALL_ROLES.includes(role))
          .map((role) => `${method} ${path} -> ${role}`),
      );
    expect(unknown).toEqual([]);
  });

  it('does not apply tenant scoping to platform-ADMIN-only routes', () => {
    // ADMIN users carry clinicId === null, so TenantGuard.assertClinicMember
    // would reject them. An ADMIN-only route that is also tenant-scoped would
    // be unreachable by every role — a latent bug, not a hardening.
    const contradictory = live
      .filter(([, , policy, flags]) => {
        if (!Array.isArray(policy)) return false;
        const roles = policy as string[];
        return roles.length === 1 && roles[0] === 'ADMIN' && flags.includes('tenant');
      })
      .map(([method, path]) => `${method} ${path}`);
    expect(contradictory).toEqual([]);
  });

  it('gates every clinic-data route behind billing except the explicitly exempt set', () => {
    // A clinic must still reach these with no or expired subscription:
    // billing management itself, plan discovery, and the shared specialty list.
    const EXEMPT = new Set([
      'GET /billing/plans',
      'GET /billing/subscription',
      'GET /billing/subscription/current',
      'GET /billing/template',
      'POST /billing/checkout-session',
      'POST /billing/checkout-session/sync',
      'POST /billing/portal-session',
      'POST /billing/subscription/cancel',
      'POST /billing/subscription/change-plan',
      'POST /billing/trial/start',
      'GET /subscriptions/template',
      'GET /specialties',
      // Diagnostic endpoint, deliberately reachable before a plan exists so an
      // OWNER can verify AI configuration during onboarding. Documented as an
      // intentional exemption on AiAssistantHealthController itself.
      'GET /ai-assistant/health',
    ]);

    const missing = live
      .filter(([method, path, policy, flags]) => {
        if (!Array.isArray(policy)) return false;
        const roles = policy as string[];
        // Platform-admin surfaces are not clinic-billed.
        if (roles.length === 1 && roles[0] === 'ADMIN') return false;
        if (flags.includes('billing')) return false;
        return !EXEMPT.has(`${method} ${path}`);
      })
      .map(([method, path]) => `${method} ${path}`);

    expect(missing).toEqual([]);
  });
});
