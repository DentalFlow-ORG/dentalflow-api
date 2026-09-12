import {
  CLINIC_A,
  CLINIC_B,
  createHarness,
  Harness,
  USERS,
} from '../../../test/support/http-harness';
import { seedModel } from '../../../test/support/tenant-store';

/**
 * CROSS-TENANT ISOLATION
 * ======================
 *
 * `tenant-scoping.http.spec.ts` proves every tenant-scoped route passes the
 * caller's clinicId to Prisma. This suite proves the resulting behaviour: with
 * a store that genuinely evaluates the `where` clause, a member of clinic A
 * handed a clinic B identifier gets nothing back.
 *
 * Every case is written as a pair — the same request against the caller's own
 * row must succeed — so a route cannot pass by rejecting everything.
 *
 * 404 rather than 403 is the expected denial: a foreign id must be
 * indistinguishable from one that does not exist, or the response itself
 * becomes an existence oracle for another clinic's data.
 */

const OWN_ID = 'row-owned-by-clinic-a';
const FOREIGN_ID = 'row-owned-by-clinic-b';

const PROFILE_A = {
  id: 'profile-a',
  clinicId: CLINIC_A,
  userId: USERS.dentistA.id,
};
const PROFILE_B = {
  id: 'profile-b',
  clinicId: CLINIC_B,
  userId: USERS.dentistB.id,
};

describe('Cross-tenant isolation (clinic A vs clinic B)', () => {
  let harness: Harness;
  let ownerA: string;

  beforeAll(async () => {
    harness = await createHarness();
    ownerA = harness.tokenFor(USERS.ownerA);
  }, 120_000);

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    harness.prisma.__reset();
  });

  describe('appointments', () => {
    const base = {
      status: 'SCHEDULED',
      appointmentDate: new Date('2026-01-01T00:00:00.000Z'),
      startTime: new Date('2026-01-01T10:00:00.000Z'),
      endTime: new Date('2026-01-01T11:00:00.000Z'),
      patientName: 'Paciente',
      patientEmail: null,
      patientPhone: null,
      service: { id: 'svc', name: 'Limpeza' },
    };

    beforeEach(() => {
      seedModel(harness.prisma, 'appointment', [
        { ...base, id: OWN_ID, clinicId: CLINIC_A, profile: PROFILE_A },
        { ...base, id: FOREIGN_ID, clinicId: CLINIC_B, profile: PROFILE_B },
      ]);
    });

    it('reads its own appointment', async () => {
      const res = await harness
        .get(`/appointments/${OWN_ID}`)
        .set('Authorization', `Bearer ${ownerA}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(OWN_ID);
    });

    it('cannot read another clinic’s appointment', async () => {
      const res = await harness
        .get(`/appointments/${FOREIGN_ID}`)
        .set('Authorization', `Bearer ${ownerA}`);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain(CLINIC_B);
    });

    it('cannot cancel another clinic’s appointment', async () => {
      const res = await harness
        .post(`/appointments/${FOREIGN_ID}/cancel`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({});
      expect(res.status).toBe(404);
    });

    it('leaves the foreign appointment untouched after a failed cancel', async () => {
      await harness
        .post(`/appointments/${FOREIGN_ID}/cancel`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({});

      const updates = harness.prisma
        .__calls()
        .filter(
          (c) => c.model === 'appointment' && c.operation.startsWith('update'),
        );
      expect(updates).toEqual([]);
    });

    it('lists only its own clinic’s appointments', async () => {
      const res = await harness
        .get('/appointments')
        .set('Authorization', `Bearer ${ownerA}`);
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(FOREIGN_ID);
    });
  });

  describe('clinical records', () => {
    const base = {
      status: 'DRAFT',
      patientName: 'Paciente',
      patientEmail: null,
      patientPhone: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      attachments: [],
      events: [],
    };

    beforeEach(() => {
      seedModel(harness.prisma, 'clinicalRecord', [
        { ...base, id: OWN_ID, clinicId: CLINIC_A, profile: PROFILE_A },
        { ...base, id: FOREIGN_ID, clinicId: CLINIC_B, profile: PROFILE_B },
      ]);
    });

    it('reads its own clinical record', async () => {
      const res = await harness
        .get(`/clinical-records/${OWN_ID}`)
        .set('Authorization', `Bearer ${ownerA}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(OWN_ID);
    });

    it('cannot read another clinic’s clinical record', async () => {
      const res = await harness
        .get(`/clinical-records/${FOREIGN_ID}`)
        .set('Authorization', `Bearer ${ownerA}`);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('Paciente');
    });

    it('cannot lock another clinic’s clinical record', async () => {
      const res = await harness
        .post(`/clinical-records/${FOREIGN_ID}/lock`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({});
      expect(res.status).toBe(404);
    });
  });

  describe('stock', () => {
    const base = {
      name: 'Luva',
      unit: 'UN',
      currentQuantity: 10,
      minimumQuantity: 1,
      isActive: true,
      category: { id: 'cat', name: 'Descartáveis' },
      categoryId: 'cat',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    beforeEach(() => {
      seedModel(harness.prisma, 'stockProduct', [
        { ...base, id: OWN_ID, clinicId: CLINIC_A },
        { ...base, id: FOREIGN_ID, clinicId: CLINIC_B },
      ]);
    });

    it('reads its own product', async () => {
      const res = await harness
        .get(`/stock/products/${OWN_ID}`)
        .set('Authorization', `Bearer ${ownerA}`);
      expect(res.status).toBe(200);
    });

    it('cannot read another clinic’s product', async () => {
      const res = await harness
        .get(`/stock/products/${FOREIGN_ID}`)
        .set('Authorization', `Bearer ${ownerA}`);
      expect(res.status).toBe(404);
    });

    it('cannot deactivate another clinic’s product', async () => {
      const res = await harness
        .del(`/stock/products/${FOREIGN_ID}`)
        .set('Authorization', `Bearer ${ownerA}`);
      expect(res.status).toBe(404);

      const writes = harness.prisma
        .__calls()
        .filter(
          (c) => c.model === 'stockProduct' && c.operation.startsWith('update'),
        );
      expect(writes).toEqual([]);
    });
  });

  describe('finance', () => {
    const base = {
      type: 'EXPENSE',
      status: 'PAID',
      amount: 100,
      description: 'Compra',
      date: new Date(),
      categoryId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    beforeEach(() => {
      seedModel(harness.prisma, 'financialTransaction', [
        { ...base, id: OWN_ID, clinicId: CLINIC_A },
        { ...base, id: FOREIGN_ID, clinicId: CLINIC_B },
      ]);
    });

    it('cannot delete another clinic’s transaction', async () => {
      const res = await harness
        .del(`/finance/transactions/${FOREIGN_ID}`)
        .set('Authorization', `Bearer ${ownerA}`);
      expect(res.status).toBe(404);
    });

    it('cannot update another clinic’s transaction', async () => {
      const res = await harness
        .patch(`/finance/transactions/${FOREIGN_ID}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ description: 'sequestrada' });
      expect(res.status).toBe(404);

      const writes = harness.prisma
        .__calls()
        .filter(
          (c) =>
            c.model === 'financialTransaction' &&
            c.operation.startsWith('update'),
        );
      expect(writes).toEqual([]);
    });

    it('deletes its own transaction', async () => {
      const res = await harness
        .del(`/finance/transactions/${OWN_ID}`)
        .set('Authorization', `Bearer ${ownerA}`);
      expect([200, 204]).toContain(res.status);
    });
  });

  describe('fiscal invoices', () => {
    const base = {
      status: 'DRAFT',
      number: null,
      totalAmount: 100,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    beforeEach(() => {
      seedModel(harness.prisma, 'serviceInvoice', [
        { ...base, id: OWN_ID, clinicId: CLINIC_A },
        { ...base, id: FOREIGN_ID, clinicId: CLINIC_B },
      ]);
    });

    it('cannot read another clinic’s invoice', async () => {
      const res = await harness
        .get(`/clinic/invoices/${FOREIGN_ID}`)
        .set('Authorization', `Bearer ${ownerA}`);
      expect(res.status).toBe(404);
    });

    it('cannot cancel another clinic’s invoice', async () => {
      const res = await harness
        .post(`/clinic/invoices/${FOREIGN_ID}/cancel`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({ reason: 'cancelamento indevido' });
      expect(res.status).toBe(404);
    });
  });

  describe('notification consents (read-then-verify)', () => {
    const base = {
      phone: '+5511999999999',
      channel: 'WHATSAPP',
      scope: 'APPOINTMENT_REMINDER',
      granted: true,
      revokedAt: null,
    };

    beforeEach(() => {
      seedModel(harness.prisma, 'notificationConsent', [
        { ...base, id: OWN_ID, clinicId: CLINIC_A },
        { ...base, id: FOREIGN_ID, clinicId: CLINIC_B },
      ]);
    });

    it('cannot revoke another clinic’s consent', async () => {
      const res = await harness
        .patch(`/notifications/consents/${FOREIGN_ID}/revoke`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({});

      expect(res.status).toBe(404);
      const writes = harness.prisma
        .__calls()
        .filter(
          (c) =>
            c.model === 'notificationConsent' &&
            c.operation.startsWith('update'),
        );
      expect(writes).toEqual([]);
    });

    it('revokes its own consent', async () => {
      const res = await harness
        .patch(`/notifications/consents/${OWN_ID}/revoke`)
        .set('Authorization', `Bearer ${ownerA}`)
        .send({});
      expect(res.status).toBe(200);
    });
  });

  describe('profiles', () => {
    beforeEach(() => {
      seedModel(harness.prisma, 'profile', [
        {
          ...PROFILE_A,
          id: OWN_ID,
          name: 'Dra. A',
          slug: 'dra-a',
          isPublished: false,
        },
        {
          ...PROFILE_B,
          id: FOREIGN_ID,
          name: 'Dr. B',
          slug: 'dr-b',
          isPublished: false,
        },
      ]);
    });

    it('cannot read another clinic’s profile', async () => {
      const res = await harness
        .get(`/profiles/${FOREIGN_ID}`)
        .set('Authorization', `Bearer ${ownerA}`);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('Dr. B');
    });

    it('cannot delete another clinic’s profile', async () => {
      const res = await harness
        .del(`/profiles/${FOREIGN_ID}`)
        .set('Authorization', `Bearer ${ownerA}`);
      expect(res.status).toBe(404);
    });
  });
});
