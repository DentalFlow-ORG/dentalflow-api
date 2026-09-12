import { createHarness, Harness, USERS } from '../../../test/support/http-harness';

describe('HTTP harness smoke', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  it('serves the public health endpoint without authentication', async () => {
    const res = await h.get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status');
  });

  it('rejects an unauthenticated call to a protected route with 401', async () => {
    const res = await h.get('/patients');
    expect(res.status).toBe(401);
  });

  it('accepts a token issued for a registered active user', async () => {
    const token = h.tokenFor(USERS.ownerA);
    const res = await h.get('/patients').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});
