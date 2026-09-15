import { BillingService } from '../../src/modules/billing/billing.service';
import {
  createIntegrationHarness,
  IntegrationHarness,
} from '../support/integration-harness';
import { createPlan, seedTwoClinics } from '../support/factories';

/**
 * The plan list, read from real PostgreSQL through the real Prisma client.
 *
 * This suite exists because of a defect a mock could not have caught, and did
 * not. `getPlans()` selected `maxLeadsPerMonth`, a Plan field removed from
 * schema.prisma on 2026-06-04 along with the leads feature. The `select` was
 * left behind, so every call threw at runtime:
 *
 *     Unknown field `maxLeadsPerMonth` for select statement on model `Plan`
 *
 * The unit suite next door mocks Prisma, so it returned whatever the mock was
 * told to and stayed green for three months while the in-app upgrade screen
 * answered 500. Only the real client validates a `select` against the real
 * model, so this assertion has to live here.
 */
describe('Billing plans (real database)', () => {
  let h: IntegrationHarness;
  let service: BillingService;

  beforeAll(async () => {
    h = await createIntegrationHarness();
    service = h.app.get(BillingService);
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await h.truncate();
  });

  it('reads the plan list without asking for a field the model no longer has', async () => {
    await createPlan(h.prisma, { slug: 'professional', name: 'Professional' });

    const result = await service.getPlans();

    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]).toMatchObject({ slug: 'professional' });
  });

  it('serves the plan list over HTTP to a clinic member', async () => {
    const seeded = await seedTwoClinics(h.prisma);

    const res = await h
      .get('/billing/plans')
      .set('Authorization', `Bearer ${h.tokenFor(seeded.ownerA)}`);

    // A 500 here is the shape the defect took: the route existed, the guard
    // chain passed, and the query threw underneath.
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.plans)).toBe(true);
  });

  it('never returns the Stripe price ids to the client', async () => {
    await createPlan(h.prisma, { slug: 'professional' });

    const result = await service.getPlans();

    expect(result.plans[0]).not.toHaveProperty('stripePriceIdMonthly');
    expect(result.plans[0]).not.toHaveProperty('stripePriceIdYearly');
    expect(result.plans[0]).toMatchObject({
      hasMonthlyPrice: expect.any(Boolean),
    });
  });

  it('hides a plan that is inactive or not public', async () => {
    await createPlan(h.prisma, { slug: 'visible' });
    await createPlan(h.prisma, { slug: 'retired', isActive: false });
    await createPlan(h.prisma, { slug: 'internal', isPublic: false });

    const result = await service.getPlans();

    expect(result.plans.map((plan) => plan.slug)).toEqual(['visible']);
  });
});
