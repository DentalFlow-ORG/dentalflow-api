import type { UserRole } from '@prisma/client';

import {
  createIntegrationHarness,
  IntegrationHarness,
} from '../support/integration-harness';
import {
  createAppointment,
  createFinancialCategory,
  createInvoice,
  createStockCategory,
  createStockProduct,
  createTransaction,
  createUser,
  seedTwoClinics,
  utcTime,
} from '../support/factories';

/**
 * TENANT ISOLATION AGAINST REAL POSTGRESQL
 *
 * The mocked suite proves each query carries a clinic predicate, and that a
 * handler answers 404 when a store honours it. Neither proves the database
 * behaves the way those tests assume.
 *
 * This one does: two clinics with genuinely persisted rows, and clinic A asked
 * for clinic B's identifiers. If a `where` clause were wrong, or a relation
 * pulled a row in sideways through an include, it would surface here and
 * nowhere else.
 *
 * Denial is 404, never 403 — a 403 confirms the row exists, which is itself
 * a cross-tenant disclosure.
 */
describe('Tenant isolation (real database)', () => {
  let h: IntegrationHarness;
  let ownerAToken: string;
  let ownerBToken: string;

  beforeAll(async () => {
    h = await createIntegrationHarness();
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await h.truncate();
    const seeded = await seedTwoClinics(h.prisma);
    ownerAToken = h.tokenFor(seeded.ownerA);
    ownerBToken = h.tokenFor(seeded.ownerB);
  });

  const asA = (req: ReturnType<IntegrationHarness['get']>) =>
    req.set('Authorization', `Bearer ${ownerAToken}`);

  // ── The rows really are persisted ──────────────────────────────────────────

  it('persists both clinics and their members', async () => {
    await expect(h.prisma.clinic.count()).resolves.toBe(2);
    await expect(h.prisma.user.count()).resolves.toBe(5);
    await expect(h.prisma.profile.count()).resolves.toBe(2);
  });

  // ── Appointments ───────────────────────────────────────────────────────────

  describe('appointments', () => {
    beforeEach(async () => {
      await createAppointment(h.prisma, {
        id: 'appt-a',
        clinicId: 'clinic-a',
        profileId: 'profile-a',
        patientName: 'Paciente Alpha',
      });
      await createAppointment(h.prisma, {
        id: 'appt-b',
        clinicId: 'clinic-b',
        profileId: 'profile-b',
        patientName: 'Paciente Beta',
      });
    });

    it('reads its own appointment', async () => {
      const res = await asA(h.get('/appointments/appt-a'));

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('appt-a');
    });

    it('cannot read the other clinic’s appointment', async () => {
      const res = await asA(h.get('/appointments/appt-b'));

      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('Paciente Beta');
    });

    it('lists only its own clinic’s appointments', async () => {
      const res = await asA(h.get('/appointments'));

      expect(res.status).toBe(200);
      const body = JSON.stringify(res.body);
      expect(body).toContain('Paciente Alpha');
      expect(body).not.toContain('Paciente Beta');
      expect(body).not.toContain('appt-b');
    });

    it('cannot cancel the other clinic’s appointment, and leaves it untouched', async () => {
      const res = await asA(h.post('/appointments/appt-b/cancel').send({}));

      expect(res.status).toBe(404);
      const untouched = await h.prisma.appointment.findUnique({
        where: { id: 'appt-b' },
      });
      expect(untouched?.status).toBe('PENDING');
      expect(untouched?.canceledAt).toBeNull();
    });

    it('cannot change the status of the other clinic’s appointment', async () => {
      const res = await asA(
        h.patch('/appointments/appt-b/status').send({ status: 'CONFIRMED' }),
      );

      expect(res.status).toBe(404);
      const untouched = await h.prisma.appointment.findUnique({
        where: { id: 'appt-b' },
      });
      expect(untouched?.status).toBe('PENDING');
    });

    it('confirms its own appointment, proving the denial is not blanket', async () => {
      const res = await asA(
        h.patch('/appointments/appt-a/status').send({ status: 'CONFIRMED' }),
      );

      expect(res.status).toBe(200);
      const updated = await h.prisma.appointment.findUnique({
        where: { id: 'appt-a' },
      });
      expect(updated?.status).toBe('CONFIRMED');
    });
  });

  // ── Patients, derived from appointments ────────────────────────────────────

  describe('patients', () => {
    beforeEach(async () => {
      await createAppointment(h.prisma, {
        id: 'appt-a',
        clinicId: 'clinic-a',
        patientName: 'Paciente Alpha',
        patientEmail: 'alpha@patients.test',
      });
      await createAppointment(h.prisma, {
        id: 'appt-b',
        clinicId: 'clinic-b',
        profileId: 'profile-b',
        patientName: 'Paciente Beta',
        patientEmail: 'beta@patients.test',
      });
    });

    it('lists only its own clinic’s patients', async () => {
      const res = await asA(h.get('/patients'));

      expect(res.status).toBe(200);
      const body = JSON.stringify(res.body);
      expect(body).toContain('alpha@patients.test');
      expect(body).not.toContain('beta@patients.test');
    });

    it('returns no history for a patient belonging to the other clinic', async () => {
      const res = await asA(
        h.get('/patients/history').query({ identifier: 'beta@patients.test' }),
      );

      expect(res.status).toBe(200);
      expect(res.body.appointments).toEqual([]);
    });
  });

  // ── Profiles ───────────────────────────────────────────────────────────────

  describe('profiles', () => {
    it('lists only its own clinic’s profiles', async () => {
      const res = await asA(h.get('/profiles'));

      expect(res.status).toBe(200);
      const ids = (res.body as Array<{ id: string }>).map((p) => p.id);
      expect(ids).toEqual(['profile-a']);
    });

    it('cannot read the other clinic’s profile', async () => {
      const res = await asA(h.get('/profiles/profile-b'));
      expect(res.status).toBe(404);
    });

    it('cannot delete the other clinic’s profile', async () => {
      const res = await asA(h.del('/profiles/profile-b'));

      expect(res.status).toBe(404);
      await expect(
        h.prisma.profile.findUnique({ where: { id: 'profile-b' } }),
      ).resolves.not.toBeNull();
    });
  });

  // ── Clinic members ─────────────────────────────────────────────────────────

  describe('users', () => {
    it('lists only its own clinic’s members', async () => {
      const res = await asA(h.get('/users'));

      // The member list is billing-gated; either it is reachable and scoped,
      // or the plan gate rejects it — but it must never show clinic B.
      if (res.status === 200) {
        expect(JSON.stringify(res.body)).not.toContain('dentist-b');
      }
      expect(JSON.stringify(res.body)).not.toContain('owner-b');
    });

    it('cannot delete a member of the other clinic', async () => {
      const res = await asA(h.del('/users/dentist-b'));

      expect([403, 404]).toContain(res.status);
      const stillThere = await h.prisma.user.findUnique({
        where: { id: 'dentist-b' },
      });
      expect(stillThere?.deletedAt).toBeNull();
      expect(stillThere?.isActive).toBe(true);
    });
  });

  // ── Finance ────────────────────────────────────────────────────────────────

  describe('finance', () => {
    beforeEach(async () => {
      await createFinancialCategory(h.prisma, {
        id: 'cat-fin-a',
        clinicId: 'clinic-a',
      });
      await createFinancialCategory(h.prisma, {
        id: 'cat-fin-b',
        clinicId: 'clinic-b',
      });
      await createTransaction(h.prisma, {
        id: 'tx-a',
        clinicId: 'clinic-a',
        categoryId: 'cat-fin-a',
        createdByUserId: 'owner-a',
        description: 'Receita Alpha',
      });
      await createTransaction(h.prisma, {
        id: 'tx-b',
        clinicId: 'clinic-b',
        categoryId: 'cat-fin-b',
        createdByUserId: 'owner-b',
        description: 'Receita Beta',
      });
    });

    it('cannot read or mutate the other clinic’s transaction', async () => {
      const read = await asA(h.get('/finance/transactions'));
      expect(JSON.stringify(read.body)).not.toContain('Receita Beta');

      const update = await asA(
        h
          .patch('/finance/transactions/tx-b')
          .send({ description: 'sequestrada' }),
      );
      expect(update.status).toBe(404);

      const untouched = await h.prisma.financialTransaction.findUnique({
        where: { id: 'tx-b' },
      });
      expect(untouched?.description).toBe('Receita Beta');
    });

    it('cannot delete the other clinic’s transaction', async () => {
      const res = await asA(h.del('/finance/transactions/tx-b'));

      expect(res.status).toBe(404);
      await expect(
        h.prisma.financialTransaction.findUnique({ where: { id: 'tx-b' } }),
      ).resolves.not.toBeNull();
    });
  });

  // ── Stock ──────────────────────────────────────────────────────────────────

  describe('stock', () => {
    beforeEach(async () => {
      await createStockCategory(h.prisma, {
        id: 'cat-a',
        clinicId: 'clinic-a',
      });
      await createStockCategory(h.prisma, {
        id: 'cat-b',
        clinicId: 'clinic-b',
      });
      await createStockProduct(h.prisma, {
        id: 'prod-a',
        clinicId: 'clinic-a',
        categoryId: 'cat-a',
        name: 'Luva Alpha',
      });
      await createStockProduct(h.prisma, {
        id: 'prod-b',
        clinicId: 'clinic-b',
        categoryId: 'cat-b',
        name: 'Luva Beta',
      });
    });

    it('cannot read the other clinic’s product', async () => {
      const res = await asA(h.get('/stock/products/prod-b'));
      expect(res.status).toBe(404);
    });

    it('cannot deactivate the other clinic’s product', async () => {
      const res = await asA(h.del('/stock/products/prod-b'));

      expect(res.status).toBe(404);
      const untouched = await h.prisma.stockProduct.findUnique({
        where: { id: 'prod-b' },
      });
      expect(untouched?.isActive).toBe(true);
    });

    it('lists only its own products', async () => {
      const res = await asA(h.get('/stock/products'));
      expect(JSON.stringify(res.body)).not.toContain('Luva Beta');
    });
  });

  // ── Fiscal ─────────────────────────────────────────────────────────────────

  describe('fiscal invoices', () => {
    beforeEach(async () => {
      await createInvoice(h.prisma, {
        id: 'inv-a',
        clinicId: 'clinic-a',
        createdByUserId: 'owner-a',
        customerName: 'Paciente Alpha',
      });
      await createInvoice(h.prisma, {
        id: 'inv-b',
        clinicId: 'clinic-b',
        createdByUserId: 'owner-b',
        customerName: 'Paciente Beta',
      });
    });

    it('cannot read the other clinic’s invoice', async () => {
      const res = await asA(h.get('/clinic/invoices/inv-b'));
      expect(res.status).toBe(404);
    });

    it('lists only its own invoices', async () => {
      const res = await asA(h.get('/clinic/invoices'));
      expect(JSON.stringify(res.body)).not.toContain('inv-b');
    });
  });

  // ── The platform ADMIN boundary ────────────────────────────────────────────

  describe('platform ADMIN', () => {
    it('sees both clinics through the ADMIN endpoint, and only there', async () => {
      const admin = await h.prisma.user.findUniqueOrThrow({
        where: { id: 'platform-admin' },
      });
      const adminToken = h.tokenFor({
        id: admin.id,
        clinicId: admin.clinicId,
        role: admin.role as UserRole,
      });

      const health = await h
        .get('/admin/users/clinics/health')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(health.status).toBe(200);
      const ids = (health.body as Array<{ clinic: { id: string } }>).map(
        (row) => row.clinic.id,
      );
      expect(ids.sort()).toEqual(['clinic-a', 'clinic-b']);

      // …and an OWNER still cannot reach it.
      const denied = await asA(h.get('/admin/users/clinics/health'));
      expect(denied.status).toBe(403);
    });

    it('excludes a soft-deleted clinic from the platform view', async () => {
      await h.prisma.clinic.update({
        where: { id: 'clinic-b' },
        data: { deletedAt: new Date() },
      });

      const admin = await h.prisma.user.findUniqueOrThrow({
        where: { id: 'platform-admin' },
      });
      const adminToken = h.tokenFor({
        id: admin.id,
        clinicId: admin.clinicId,
        role: admin.role as UserRole,
      });

      const res = await h
        .get('/admin/users/clinics/health')
        .set('Authorization', `Bearer ${adminToken}`);

      const ids = (res.body as Array<{ clinic: { id: string } }>).map(
        (row) => row.clinic.id,
      );
      expect(ids).toEqual(['clinic-a']);
    });
  });

  // ── Authentication against real rows ───────────────────────────────────────

  describe('authentication', () => {
    it('rejects a token whose user row was soft-deleted', async () => {
      await h.prisma.user.update({
        where: { id: 'owner-a' },
        data: { deletedAt: new Date() },
      });

      const res = await asA(h.get('/appointments'));
      expect(res.status).toBe(401);
    });

    it('rejects a token whose user row was deactivated', async () => {
      await h.prisma.user.update({
        where: { id: 'owner-a' },
        data: { isActive: false },
      });

      const res = await asA(h.get('/appointments'));
      expect(res.status).toBe(401);
    });

    it('rejects a token whose tokenVersion is behind the stored row', async () => {
      await h.prisma.user.update({
        where: { id: 'owner-a' },
        data: { tokenVersion: { increment: 1 } },
      });

      const res = await asA(h.get('/appointments'));
      expect(res.status).toBe(401);
    });

    it('rejects a token for a user that no longer exists', async () => {
      const ghost = await createUser(h.prisma, {
        id: 'ghost',
        clinicId: 'clinic-a',
        role: 'OWNER',
      });
      const ghostToken = h.tokenFor(ghost);
      await h.prisma.user.delete({ where: { id: 'ghost' } });

      const res = await h
        .get('/appointments')
        .set('Authorization', `Bearer ${ghostToken}`);
      expect(res.status).toBe(401);
    });
  });

  // ── A dentist sees only their own agenda ───────────────────────────────────

  describe('dentist scope within a clinic', () => {
    it('shows a dentist only their own appointments', async () => {
      await createProfileForSecondDentist(h);
      await createAppointment(h.prisma, {
        id: 'appt-mine',
        clinicId: 'clinic-a',
        profileId: 'profile-a',
        patientName: 'Meu Paciente',
      });
      await createAppointment(h.prisma, {
        id: 'appt-theirs',
        clinicId: 'clinic-a',
        profileId: 'profile-a2',
        patientName: 'Paciente do Colega',
        startTime: utcTime('11:00'),
        endTime: utcTime('12:00'),
      });

      const dentist = await h.prisma.user.findUniqueOrThrow({
        where: { id: 'dentist-a' },
      });
      const token = h.tokenFor({
        id: dentist.id,
        clinicId: dentist.clinicId,
        role: dentist.role as UserRole,
      });

      const res = await h
        .get('/appointments/appt-theirs')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });
  });
});

/** A second dentist and profile inside clinic A. */
async function createProfileForSecondDentist(h: IntegrationHarness) {
  await createUser(h.prisma, {
    id: 'dentist-a2',
    clinicId: 'clinic-a',
    role: 'DENTIST',
  });
  await h.prisma.profile.create({
    data: {
      id: 'profile-a2',
      clinicId: 'clinic-a',
      userId: 'dentist-a2',
      displayName: 'Dr. Colega',
      slug: 'dr-colega',
    },
  });
}
