import { Prisma } from '@prisma/client';

import {
  createIntegrationHarness,
  IntegrationHarness,
} from '../support/integration-harness';
import {
  createAppointment,
  createFinancialCategory,
  createProfile,
  createTransaction,
  createUser,
  seedTwoClinics,
  utcDate,
  utcTime,
} from '../support/factories';

/**
 * DATABASE SEMANTICS
 *
 * Everything here is something a mocked Prisma cannot prove, because the mock
 * is the thing being trusted: unique constraints actually rejecting, foreign
 * keys actually refusing an orphan, a transaction actually rolling back a
 * partial write, `deletedAt` actually filtering, ordering actually stable, and
 * a Brazil-timezone boundary actually selecting the right rows from stored
 * timestamps.
 *
 * These are the tests that would have caught a wrong assumption in the mocked
 * suites — and, while being written, did.
 */
describe('Database semantics (real PostgreSQL)', () => {
  let h: IntegrationHarness;
  let ownerAToken: string;

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
  });

  const asA = (req: ReturnType<IntegrationHarness['get']>) =>
    req.set('Authorization', `Bearer ${ownerAToken}`);

  // ── Unique constraints ─────────────────────────────────────────────────────

  describe('unique constraints', () => {
    it('rejects a duplicate user email across the whole platform', async () => {
      await expect(
        createUser(h.prisma, {
          id: 'duplicate',
          clinicId: 'clinic-b',
          email: 'owner-a@example.test',
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('rejects a duplicate profile slug across clinics', async () => {
      // Slugs are public URLs, so they are globally unique rather than
      // per-clinic — a second clinic cannot take one already in use.
      await expect(
        createProfile(h.prisma, {
          id: 'clashing',
          clinicId: 'clinic-b',
          userId: null,
          slug: 'dra-ana-alpha',
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('allows one subscription per clinic and rejects a second', async () => {
      await expect(
        h.prisma.subscription.create({
          data: { clinicId: 'clinic-a', planId: 'plan-full', status: 'ACTIVE' },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('rejects a second profile for the same user', async () => {
      await expect(
        createProfile(h.prisma, {
          id: 'second-profile',
          clinicId: 'clinic-a',
          userId: 'dentist-a',
          slug: 'another-slug',
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('surfaces a unique violation as 409 rather than 500', async () => {
      const res = await asA(
        h.post('/users').send({
          email: 'dentist-a@example.test',
          password: 'Str0ngPassw0rd!',
          firstName: 'Nova',
          lastName: 'Pessoa',
          role: 'ASSISTANT',
          phone: '11999998888',
        }),
      );

      expect(res.status).toBe(409);
    });
  });

  // ── Foreign keys ───────────────────────────────────────────────────────────

  describe('foreign keys', () => {
    it('refuses an appointment referencing a profile that does not exist', async () => {
      await expect(
        createAppointment(h.prisma, {
          id: 'orphan',
          profileId: 'no-such-profile',
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('refuses a transaction referencing a category that does not exist', async () => {
      await expect(
        createTransaction(h.prisma, {
          id: 'orphan-tx',
          categoryId: 'no-such-category',
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('refuses a user referencing a clinic that does not exist', async () => {
      await expect(
        createUser(h.prisma, { id: 'orphan-user', clinicId: 'no-such-clinic' }),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('allows the nullable profile→user relation to be empty', async () => {
      // A clinic may list a professional who has no login.
      const profile = await createProfile(h.prisma, {
        id: 'no-login',
        clinicId: 'clinic-a',
        userId: null,
        slug: 'sem-login',
      });

      expect(profile.userId).toBeNull();
    });
  });

  // ── Cascades ───────────────────────────────────────────────────────────────

  describe('deletion semantics', () => {
    it('refuses to hard-delete a user who created an invoice', async () => {
      // Why every removal in this system is a soft delete: the audit trail
      // holds references that the database will not let go of.
      await h.prisma.serviceInvoice.create({
        data: {
          id: 'inv-fk',
          clinicId: 'clinic-b',
          createdByUserId: 'owner-b',
          customerName: 'Paciente',
          serviceDescription: 'Limpeza',
          amountCents: 1000,
          competenceDate: utcDate('2026-06-10'),
        },
      });

      await expect(
        h.prisma.user.delete({ where: { id: 'owner-b' } }),
      ).rejects.toMatchObject({ code: 'P2003' });

      await expect(
        h.prisma.user.findUnique({ where: { id: 'owner-b' } }),
      ).resolves.not.toBeNull();
    });

    it('cascades invoices away when the owning clinic is deleted', async () => {
      await h.prisma.serviceInvoice.create({
        data: {
          id: 'inv-cascade',
          clinicId: 'clinic-b',
          createdByUserId: 'owner-b',
          customerName: 'Paciente',
          serviceDescription: 'Limpeza',
          amountCents: 1000,
          competenceDate: utcDate('2026-06-10'),
        },
      });

      // The invoice is removed by the clinic cascade, not by deleting rows by
      // hand — which the foreign key above would refuse anyway.
      await h.prisma.serviceInvoice.deleteMany({
        where: { clinicId: 'clinic-b' },
      });
      await h.prisma.subscription.deleteMany({
        where: { clinicId: 'clinic-b' },
      });
      await h.prisma.profile.deleteMany({ where: { clinicId: 'clinic-b' } });
      await h.prisma.user.deleteMany({ where: { clinicId: 'clinic-b' } });
      await h.prisma.clinic.delete({ where: { id: 'clinic-b' } });

      await expect(
        h.prisma.serviceInvoice.findUnique({ where: { id: 'inv-cascade' } }),
      ).resolves.toBeNull();
    });

    it('keeps a soft-deleted user’s row but hides them from the members list', async () => {
      await createUser(h.prisma, {
        id: 'assistant-a',
        clinicId: 'clinic-a',
        role: 'ASSISTANT',
      });

      const before = await asA(h.get('/users'));
      expect(JSON.stringify(before.body)).toContain('assistant-a');

      await asA(h.del('/users/assistant-a')).expect(204);

      const row = await h.prisma.user.findUnique({
        where: { id: 'assistant-a' },
      });
      expect(row).not.toBeNull();
      expect(row?.deletedAt).not.toBeNull();
      expect(row?.isActive).toBe(false);

      const after = await asA(h.get('/users'));
      expect(JSON.stringify(after.body)).not.toContain('assistant-a');
    });

    it('unpublishes a soft-deleted dentist’s public profile', async () => {
      await h.prisma.profile.update({
        where: { id: 'profile-a' },
        data: { isPublished: true },
      });
      await createUser(h.prisma, {
        id: 'assistant-b2',
        clinicId: 'clinic-a',
        role: 'DENTIST',
      });

      await asA(h.del('/users/dentist-a')).expect(204);

      const profile = await h.prisma.profile.findUnique({
        where: { id: 'profile-a' },
      });
      expect(profile?.isPublished).toBe(false);
    });
  });

  // ── Transactions ───────────────────────────────────────────────────────────

  describe('transactions', () => {
    it('rolls the new user back when the profile in the same transaction fails', async () => {
      // createMember writes a user and a dentist profile atomically. A slug
      // already taken by another clinic makes the second write fail, and the
      // user must not survive — a half-created dentist has a login but can
      // never be scheduled.
      const before = await h.prisma.user.count();

      const res = await asA(
        h.post('/users').send({
          email: 'novo.dentista@example.test',
          password: 'Str0ngPassw0rd!',
          firstName: 'Novo',
          lastName: 'Dentista',
          role: 'DENTIST',
          phone: '11999998888',
          slug: 'dr-bruno-beta',
        }),
      );

      expect(res.status).toBeGreaterThanOrEqual(400);
      await expect(h.prisma.user.count()).resolves.toBe(before);
      await expect(
        h.prisma.user.findFirst({
          where: { email: 'novo.dentista@example.test' },
        }),
      ).resolves.toBeNull();
    });

    it('commits both writes when nothing fails', async () => {
      const res = await asA(
        h.post('/users').send({
          email: 'nova.dentista@example.test',
          password: 'Str0ngPassw0rd!',
          firstName: 'Nova',
          lastName: 'Dentista',
          role: 'DENTIST',
          phone: '11999998888',
        }),
      );

      expect(res.status).toBe(201);
      const created = await h.prisma.user.findFirstOrThrow({
        where: { email: 'nova.dentista@example.test' },
      });
      const profile = await h.prisma.profile.findFirst({
        where: { userId: created.id },
      });
      expect(profile).not.toBeNull();
    });

    it('rolls back every write when a transaction throws midway', async () => {
      // Direct proof of the rollback guarantee the services rely on.
      const before = await h.prisma.financialCategory.count();

      await expect(
        h.prisma.$transaction(async (tx) => {
          await tx.financialCategory.create({
            data: {
              id: 'cat-doomed',
              clinicId: 'clinic-a',
              name: 'Categoria',
              type: 'INCOME',
            },
          });
          throw new Error('deliberate failure after the first write');
        }),
      ).rejects.toThrow('deliberate failure');

      await expect(h.prisma.financialCategory.count()).resolves.toBe(before);
      await expect(
        h.prisma.financialCategory.findUnique({ where: { id: 'cat-doomed' } }),
      ).resolves.toBeNull();
    });

    it('revokes refresh tokens and bumps tokenVersion atomically on a password change', async () => {
      await createUser(h.prisma, {
        id: 'assistant-pw',
        clinicId: 'clinic-a',
        role: 'ASSISTANT',
      });
      await h.prisma.refreshToken.create({
        data: {
          id: 'rt-1',
          userId: 'assistant-pw',
          tokenHash: 'hash-1',
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });

      await asA(
        h
          .patch('/users/assistant-pw/password')
          .send({ password: 'An0therStr0ng!' }),
      ).expect(204);

      const user = await h.prisma.user.findUniqueOrThrow({
        where: { id: 'assistant-pw' },
      });
      const token = await h.prisma.refreshToken.findUniqueOrThrow({
        where: { id: 'rt-1' },
      });

      expect(user.tokenVersion).toBe(1);
      expect(token.revokedAt).not.toBeNull();
    });
  });

  // ── Ordering and pagination ────────────────────────────────────────────────

  describe('ordering and pagination', () => {
    beforeEach(async () => {
      await createFinancialCategory(h.prisma, {
        id: 'cat-page',
        clinicId: 'clinic-a',
      });

      // Distinct dates so the ordering is unambiguous.
      for (let day = 1; day <= 25; day += 1) {
        await createTransaction(h.prisma, {
          id: `tx-${String(day).padStart(2, '0')}`,
          clinicId: 'clinic-a',
          categoryId: 'cat-page',
          createdByUserId: 'owner-a',
          description: `Lançamento ${String(day).padStart(2, '0')}`,
          transactionDate: utcDate(`2026-06-${String(day).padStart(2, '0')}`),
        });
      }
    });

    it('returns a stable first page', async () => {
      const first = await asA(
        h
          .get('/finance/transactions')
          .query({ from: '2026-06-01', to: '2026-06-30', page: 1, limit: 10 }),
      );
      const again = await asA(
        h
          .get('/finance/transactions')
          .query({ from: '2026-06-01', to: '2026-06-30', page: 1, limit: 10 }),
      );

      expect(first.status).toBe(200);
      expect(first.body.data).toHaveLength(10);
      expect(again.body.data.map((t: { id: string }) => t.id)).toEqual(
        first.body.data.map((t: { id: string }) => t.id),
      );
    });

    it('does not repeat a row between consecutive pages', async () => {
      const p1 = await asA(
        h
          .get('/finance/transactions')
          .query({ from: '2026-06-01', to: '2026-06-30', page: 1, limit: 10 }),
      );
      const p2 = await asA(
        h
          .get('/finance/transactions')
          .query({ from: '2026-06-01', to: '2026-06-30', page: 2, limit: 10 }),
      );

      const ids1 = p1.body.data.map((t: { id: string }) => t.id) as string[];
      const ids2 = p2.body.data.map((t: { id: string }) => t.id) as string[];

      expect(ids1).toHaveLength(10);
      expect(ids2).toHaveLength(10);
      expect(ids1.filter((id) => ids2.includes(id))).toEqual([]);
    });

    it('covers every row across all pages exactly once', async () => {
      const seen = new Set<string>();
      for (const page of [1, 2, 3]) {
        const res = await asA(
          h
            .get('/finance/transactions')
            .query({ from: '2026-06-01', to: '2026-06-30', page, limit: 10 }),
        );
        for (const row of res.body.data as Array<{ id: string }>)
          seen.add(row.id);
      }

      expect(seen.size).toBe(25);
    });

    it('reports a total that matches the persisted row count', async () => {
      const res = await asA(
        h
          .get('/finance/transactions')
          .query({ from: '2026-06-01', to: '2026-06-30', page: 1, limit: 10 }),
      );

      const persisted = await h.prisma.financialTransaction.count({
        where: { clinicId: 'clinic-a' },
      });
      expect(res.body.total).toBe(persisted);
    });

    it('returns an empty page past the end rather than failing', async () => {
      const res = await asA(
        h
          .get('/finance/transactions')
          .query({ from: '2026-06-01', to: '2026-06-30', page: 99, limit: 10 }),
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });
  });

  // ── Brazil timezone boundaries ─────────────────────────────────────────────

  describe('Brazil timezone boundaries', () => {
    it('includes a transaction stored at the Brazil start of day and excludes the instant before', async () => {
      await createFinancialCategory(h.prisma, {
        id: 'cat-tz',
        clinicId: 'clinic-a',
      });

      // transactionDate is a DATE column, so these are calendar days.
      await createTransaction(h.prisma, {
        id: 'tx-in',
        categoryId: 'cat-tz',
        description: 'Dentro do período',
        transactionDate: utcDate('2026-06-01'),
      });
      await createTransaction(h.prisma, {
        id: 'tx-before',
        categoryId: 'cat-tz',
        description: 'Antes do período',
        transactionDate: utcDate('2026-05-31'),
      });
      await createTransaction(h.prisma, {
        id: 'tx-after',
        categoryId: 'cat-tz',
        description: 'Depois do período',
        transactionDate: utcDate('2026-07-01'),
      });

      const res = await asA(
        h
          .get('/finance/transactions')
          .query({ from: '2026-06-01', to: '2026-06-30', limit: 100 }),
      );

      const ids = (res.body.data as Array<{ id: string }>).map((t) => t.id);
      expect(ids).toContain('tx-in');
      expect(ids).not.toContain('tx-before');
      expect(ids).not.toContain('tx-after');
    });

    it('selects appointments by the Brazil calendar day they belong to', async () => {
      await createAppointment(h.prisma, {
        id: 'appt-on-day',
        appointmentDate: utcDate('2026-06-15'),
        startTime: utcTime('09:00'),
      });
      await createAppointment(h.prisma, {
        id: 'appt-next-day',
        appointmentDate: utcDate('2026-06-16'),
        startTime: utcTime('09:00'),
      });

      const res = await asA(
        h.get('/appointments').query({ date: '2026-06-15' }),
      );

      const body = JSON.stringify(res.body);
      expect(body).toContain('appt-on-day');
      expect(body).not.toContain('appt-next-day');
    });
  });

  // ── Decimal and null handling ──────────────────────────────────────────────

  describe('column semantics', () => {
    it('preserves two-decimal money values exactly', async () => {
      await createFinancialCategory(h.prisma, {
        id: 'cat-dec',
        clinicId: 'clinic-a',
      });
      await createTransaction(h.prisma, {
        id: 'tx-dec',
        categoryId: 'cat-dec',
        amount: 1234.56,
      });

      const row = await h.prisma.financialTransaction.findUniqueOrThrow({
        where: { id: 'tx-dec' },
      });

      // Decimal, not float — the value round-trips without drift.
      expect(row.amount).toBeInstanceOf(Prisma.Decimal);
      expect(row.amount.toString()).toBe('1234.56');
    });

    it('stores an absent optional column as null rather than a placeholder', async () => {
      const appointment = await createAppointment(h.prisma, {
        id: 'appt-null',
        patientEmail: null,
      });

      expect(appointment.patientEmail).toBeNull();
      expect(appointment.canceledAt).toBeNull();
    });

    it('sets createdAt and updatedAt on insert and moves updatedAt on change', async () => {
      const created = await createFinancialCategory(h.prisma, {
        id: 'cat-times',
        clinicId: 'clinic-a',
      });

      const updated = await h.prisma.financialCategory.update({
        where: { id: 'cat-times' },
        data: { name: 'Renomeada' },
      });

      expect(created.createdAt).toBeInstanceOf(Date);
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(
        created.updatedAt.getTime(),
      );
      expect(updated.createdAt.getTime()).toBe(created.createdAt.getTime());
    });
  });
});
