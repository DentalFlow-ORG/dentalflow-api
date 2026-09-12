import type { UserRole } from '@prisma/client';

import {
  apiPath,
  createHarness,
  Harness,
  TestUser,
} from '../../../test/support/http-harness';
import { ROUTE_ACCESS_MATRIX } from '../../../test/support/route-access-matrix';

/**
 * AUTHORIZATION ENFORCEMENT
 * =========================
 *
 * `route-access-matrix.spec.ts` proves each route *declares* the intended
 * policy. This suite proves the running application *enforces* it, by issuing
 * a real HTTP request per (route × principal) through the full global guard
 * chain: JwtAuthGuard → TenantGuard → RolesGuard → BillingAccessGuard →
 * PlanFeatureGuard.
 *
 * A permitted principal is not asserted to receive 200: the handler runs
 * against an empty mocked database and may legitimately answer 400/404/500, or
 * even 401/403 from a *domain* rule (no subscription on file, plan tier too
 * low, user row missing). What must never happen is a rejection produced by
 * the guard chain itself, so the assertion matches on the exact messages those
 * guards emit rather than on the status code alone. Handler behaviour is
 * covered by each module's own suite.
 */

/**
 * Every rejection message the route-authorization chain can produce.
 * Sourced from RolesGuard, TenantGuard and AccessPolicyService.
 */
const AUTHORIZATION_REJECTIONS = [
  // JwtAuthGuard's own rejection. JwtStrategy's 'Sessão inválida' is
  // deliberately absent: several handlers reuse that wording for domain
  // outcomes (an absent refresh token, a missing user row), so it cannot
  // distinguish a guard rejection. The unauthenticated-request assertion below
  // already proves the guard rejects anonymous callers.
  'Unauthorized',
  'Você não tem permissão para acessar este recurso',
  'No access policy declared on this route',
  'Vínculo com clínica obrigatório',
  'Vínculo com clínica obrigatório.',
  'Acesso à clínica negado',
  'Acesso de proprietário da clínica obrigatório',
  'Acesso operacional da clínica obrigatório',
  'Acesso de proprietário ou assistente obrigatório',
  'Acesso de administrador da plataforma obrigatório',
  'Profissionais podem acessar apenas o próprio perfil',
  'Usuários da plataforma ou públicos não podem pertencer a uma clínica',
  'Usuários da clínica devem estar vinculados a uma clínica',
];

function rejectionMessage(body: unknown): string | null {
  const message = (body as { message?: unknown } | null)?.message;
  if (typeof message !== 'string') return null;
  return AUTHORIZATION_REJECTIONS.includes(message) ? message : null;
}

const CLINIC_A = 'clinic-authz-a';

type Principal = { name: string; user: TestUser };

const PRINCIPALS: Principal[] = [
  { name: 'ADMIN', user: { id: 'authz-admin', clinicId: null, role: 'ADMIN' } },
  {
    name: 'OWNER',
    user: { id: 'authz-owner', clinicId: CLINIC_A, role: 'OWNER' },
  },
  {
    name: 'DENTIST',
    user: { id: 'authz-dentist', clinicId: CLINIC_A, role: 'DENTIST' },
  },
  {
    name: 'ASSISTANT',
    user: { id: 'authz-assistant', clinicId: CLINIC_A, role: 'ASSISTANT' },
  },
];

/** Stand-in for any `:param` segment; shape is irrelevant to authorization. */
const PARAM_STUB = '00000000-0000-4000-8000-000000000000';

function concretePath(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, PARAM_STUB);
}

/**
 * ADMIN carries `clinicId === null`, so TenantGuard rejects it on any
 * tenant-scoped route regardless of the role list — including the
 * `ANY_AUTHENTICATED` ones.
 */
function isPermitted(
  policy: 'PUBLIC' | 'ANY_AUTHENTICATED' | UserRole[],
  flags: string[],
  role: UserRole,
): boolean {
  if (policy === 'PUBLIC') return true;
  if (flags.includes('tenant') && role === 'ADMIN') return false;
  if (policy === 'ANY_AUTHENTICATED') return true;
  return policy.includes(role);
}

describe('Authorization enforcement (every route × every role)', () => {
  let harness: Harness;
  let tokens: Record<string, string>;
  let fetchSpy: jest.SpyInstance;

  beforeAll(async () => {
    // Nothing in this suite may reach an external provider. Any handler that
    // tries gets a rejected promise rather than a real network call.
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('network disabled in authorization tests'));

    harness = await createHarness();
    tokens = Object.fromEntries(
      PRINCIPALS.map((p) => [p.name, harness.tokenFor(p.user)]),
    );
  }, 120_000);

  afterAll(async () => {
    fetchSpy.mockRestore();
    await harness.close();
  });

  function send(method: string, path: string, token?: string) {
    const agent = harness.app.getHttpServer();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const request = require('supertest') as typeof import('supertest');
    const verb = method.toLowerCase() as
      | 'get'
      | 'post'
      | 'put'
      | 'patch'
      | 'delete';
    const req = request(agent)[verb](apiPath(concretePath(path)));
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  const cases = ROUTE_ACCESS_MATRIX.filter(([method]) =>
    ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method),
  );

  describe.each(cases)('%s %s', (method, path, policy, flags) => {
    if (policy !== 'PUBLIC') {
      it('rejects an unauthenticated request with 401', async () => {
        const res = await send(method, path);
        expect(`${method} ${path} -> ${res.status}`).toBe(
          `${method} ${path} -> 401`,
        );
      });
    } else {
      it('is reachable without route authorization', async () => {
        const res = await send(method, path);
        expect(rejectionMessage(res.body)).toBeNull();
      });
    }

    it.each(PRINCIPALS.map((p) => [p.name] as const))('%s', async (name) => {
      const role = name as UserRole;
      const res = await send(method, path, tokens[name]);

      const where = `${method} ${path} as ${name}`;

      if (isPermitted(policy, flags, role)) {
        // The guard chain must not be what stops a permitted principal.
        const blocked = rejectionMessage(res.body);
        expect(
          blocked ? `${where} blocked by "${blocked}"` : 'authorized',
        ).toBe('authorized');
      } else {
        expect(`${where} -> ${res.status}`).toBe(`${where} -> 403`);
        // …and specifically because authorization said no.
        expect(
          `${where}: ${rejectionMessage(res.body) ?? 'NOT an authorization rejection'}`,
        ).not.toContain('NOT an authorization rejection');
      }
    });
  });

  describe('non-clinic principals', () => {
    /**
     * PATIENT is a real, issuable role: Google sign-up creates a user with
     * role PATIENT and clinicId null, who then calls `/auth/complete-profile`
     * to become a clinic OWNER. Password login rejects PATIENT outright
     * (AuthService PATIENT_ROLE_NOT_ALLOWED), so a PATIENT token only exists
     * during that onboarding window.
     *
     * These are the only routes a PATIENT may reach — the identity and
     * onboarding surface. Every other authenticated route must answer 403.
     */
    const PATIENT_REACHABLE = new Set([
      'POST /auth/complete-profile',
      'POST /auth/logout',
      'GET /auth/me',
      'GET /users/me',
      'POST /privacy/cookie-consent/authenticated',
    ]);

    it('confines a PATIENT token to the identity and onboarding surface', async () => {
      const patientToken = harness.tokenFor({
        id: 'authz-patient',
        clinicId: null,
        role: 'PATIENT' as UserRole,
      });

      const protectedRoutes = cases.filter(
        ([, , policy]) => policy !== 'PUBLIC',
      );
      const escalations: string[] = [];
      const unexpectedDenials: string[] = [];

      for (const [method, path] of protectedRoutes) {
        const res = await send(method, path, patientToken);
        const route = `${method} ${path}`;

        if (PATIENT_REACHABLE.has(route)) {
          if (res.status === 403) unexpectedDenials.push(`${route} -> 403`);
        } else if (res.status !== 403) {
          escalations.push(`${route} -> ${res.status}`);
        }
      }

      expect(escalations).toEqual([]);
      expect(unexpectedDenials).toEqual([]);
    }, 120_000);

    it('reaches no clinic-scoped or platform-admin data as PATIENT', () => {
      // Guards the allow-list above from being widened by accident.
      const leaked = [...PATIENT_REACHABLE].filter(
        (route) =>
          route.includes('/admin/') ||
          route.includes('/patients') ||
          route.includes('/clinical-records') ||
          route.includes('/finance') ||
          route.includes('/appointments') ||
          route.includes('/stock') ||
          route.includes('/clinic/'),
      );
      expect(leaked).toEqual([]);
    });

    it('rejects a clinic role whose token carries no clinicId', async () => {
      const malformed = harness.tokenFor({
        id: 'authz-owner-no-clinic',
        clinicId: null,
        role: 'OWNER',
      });

      const res = await send('GET', '/patients', malformed);
      expect(res.status).toBe(403);
    });

    it('rejects an ADMIN token that claims clinic membership', async () => {
      const malformed = harness.tokenFor({
        id: 'authz-admin-with-clinic',
        clinicId: CLINIC_A,
        role: 'ADMIN',
      });

      const res = await send('GET', '/admin/users', malformed);
      expect(res.status).toBe(403);
    });
  });
});
