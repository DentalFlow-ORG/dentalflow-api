import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AppointmentsService } from '../../src/modules/appointments/appointments.service';
import {
  createIntegrationHarness,
  IntegrationHarness,
} from '../support/integration-harness';
import {
  createAppointment,
  createFinancialCategory,
  seedTwoClinics,
} from '../support/factories';

/**
 * Recording a payment on an appointment, against real PostgreSQL.
 *
 * This is the one place in the application where a clinical action creates
 * money: `updateAppointmentPayment` writes the appointment's payment fields
 * and, inside the same transaction, upserts the matching
 * `FinancialTransaction`. It had no test at all.
 *
 * It has to be a database test. The behaviour that can go wrong is the
 * database's: the composite unique key that makes re-recording a payment an
 * update rather than a duplicate, the `Decimal` column that holds reais while
 * the API speaks centavos, the `@db.Date` column that must land on the right
 * calendar day, and the transaction that must roll the appointment back when
 * the financial write fails. A mock asserts none of that.
 */
describe('Appointment payment → financial transaction (real database)', () => {
  let h: IntegrationHarness;
  let service: AppointmentsService;

  const CLINIC = 'clinic-a';
  const APPOINTMENT = 'appt-pay';
  const OWNER = 'owner-a';

  beforeAll(async () => {
    h = await createIntegrationHarness();
    service = h.app.get(AppointmentsService);
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await h.truncate();
    await seedTwoClinics(h.prisma);
    await createAppointment(h.prisma, {
      id: APPOINTMENT,
      clinicId: CLINIC,
      profileId: 'profile-a',
      patientName: 'Maria Silva',
    });
  });

  /** The service-payment transaction for the appointment, if any. */
  function linkedTransaction() {
    return h.prisma.financialTransaction.findFirst({
      where: {
        clinicId: CLINIC,
        appointmentId: APPOINTMENT,
        source: 'SERVICE_PAYMENT',
      },
    });
  }

  // ── PAID ───────────────────────────────────────────────────────────────────

  describe('marking an appointment paid', () => {
    it('records the income as reais, not the centavos the API speaks', async () => {
      await service.updateAppointmentPayment(CLINIC, OWNER, APPOINTMENT, {
        paymentStatus: 'PAID',
        paidAmountCents: 25_050,
        paymentDate: '2026-06-10',
      } as never);

      const tx = await linkedTransaction();

      expect(tx).not.toBeNull();
      // 25050 centavos is R$ 250,50 — a Decimal(10,2), not an integer.
      expect(new Prisma.Decimal(tx!.amount).toFixed(2)).toBe('250.50');
      expect(tx!.type).toBe('INCOME');
      expect(tx!.status).toBe('PAID');
      expect(tx!.paidAt).not.toBeNull();
    });

    it('stores the transaction on the calendar day of the payment', async () => {
      await service.updateAppointmentPayment(CLINIC, OWNER, APPOINTMENT, {
        paymentStatus: 'PAID',
        paidAmountCents: 10_000,
        paymentDate: '2026-06-10',
      } as never);

      const tx = await linkedTransaction();

      // A DATE column: it must come back as that day at UTC midnight, with no
      // timezone shift in either direction.
      expect(tx!.transactionDate.toISOString()).toBe(
        '2026-06-10T00:00:00.000Z',
      );
    });

    it('creates the default income category the first time and reuses it after', async () => {
      await service.updateAppointmentPayment(CLINIC, OWNER, APPOINTMENT, {
        paymentStatus: 'PAID',
        paidAmountCents: 10_000,
      } as never);

      await createAppointment(h.prisma, {
        id: 'appt-pay-2',
        clinicId: CLINIC,
        profileId: 'profile-a',
      });
      await service.updateAppointmentPayment(CLINIC, OWNER, 'appt-pay-2', {
        paymentStatus: 'PAID',
        paidAmountCents: 20_000,
      } as never);

      const categories = await h.prisma.financialCategory.findMany({
        where: {
          clinicId: CLINIC,
          type: 'INCOME',
          name: 'Servicos odontologicos',
        },
      });

      // The upsert is guarded by a composite unique key; a second payment must
      // not produce a second category.
      expect(categories).toHaveLength(1);
      expect(categories[0].isDefault).toBe(true);
    });

    it('names the transaction after the patient', async () => {
      await service.updateAppointmentPayment(CLINIC, OWNER, APPOINTMENT, {
        paymentStatus: 'PAID',
        paidAmountCents: 10_000,
      } as never);

      const tx = await linkedTransaction();
      expect(tx!.description).toContain('Maria Silva');
      expect(tx!.description).not.toContain('[Parcial]');
    });

    it('copies the payment fields onto the appointment itself', async () => {
      await service.updateAppointmentPayment(CLINIC, OWNER, APPOINTMENT, {
        paymentStatus: 'PAID',
        paidAmountCents: 10_000,
        estimatedAmountCents: 12_000,
        paymentMethod: 'PIX',
        paymentNotes: 'Pago na recepção',
      } as never);

      const appointment = await h.prisma.appointment.findUniqueOrThrow({
        where: { id: APPOINTMENT },
      });

      expect(appointment.paymentStatus).toBe('PAID');
      expect(appointment.paidAmountCents).toBe(10_000);
      expect(appointment.estimatedAmountCents).toBe(12_000);
      expect(appointment.paymentMethod).toBe('PIX');
      expect(appointment.paymentNotes).toBe('Pago na recepção');
    });
  });

  // ── Re-recording ───────────────────────────────────────────────────────────

  describe('recording the payment again', () => {
    it('updates the one transaction instead of creating a second', async () => {
      await service.updateAppointmentPayment(CLINIC, OWNER, APPOINTMENT, {
        paymentStatus: 'PAID',
        paidAmountCents: 10_000,
      } as never);
      await service.updateAppointmentPayment(CLINIC, OWNER, APPOINTMENT, {
        paymentStatus: 'PAID',
        paidAmountCents: 30_000,
      } as never);

      const all = await h.prisma.financialTransaction.findMany({
        where: { clinicId: CLINIC, appointmentId: APPOINTMENT },
      });

      // The `clinicId_appointmentId_source` unique key is what makes the
      // upsert an update. Correcting an amount must not double the revenue.
      expect(all).toHaveLength(1);
      expect(new Prisma.Decimal(all[0].amount).toFixed(2)).toBe('300.00');
    });

    it('keeps the appointment and the transaction agreeing after a correction', async () => {
      await service.updateAppointmentPayment(CLINIC, OWNER, APPOINTMENT, {
        paymentStatus: 'PAID',
        paidAmountCents: 10_000,
      } as never);
      await service.updateAppointmentPayment(CLINIC, OWNER, APPOINTMENT, {
        paymentStatus: 'PARTIALLY_PAID',
        paidAmountCents: 4_000,
      } as never);

      const appointment = await h.prisma.appointment.findUniqueOrThrow({
        where: { id: APPOINTMENT },
      });
      const tx = await linkedTransaction();

      expect(appointment.paidAmountCents).toBe(4_000);
      expect(new Prisma.Decimal(tx!.amount).toFixed(2)).toBe('40.00');
    });
  });

  // ── PARTIALLY_PAID ─────────────────────────────────────────────────────────

  describe('a partial payment', () => {
    it('books the amount received but leaves the transaction pending', async () => {
      await service.updateAppointmentPayment(CLINIC, OWNER, APPOINTMENT, {
        paymentStatus: 'PARTIALLY_PAID',
        paidAmountCents: 5_000,
      } as never);

      const tx = await linkedTransaction();

      // FinancialTransactionStatus has no PARTIAL: a partial payment is a
      // PENDING transaction carrying the amount actually received.
      expect(tx!.status).toBe('PENDING');
      expect(tx!.paidAt).toBeNull();
      expect(new Prisma.Decimal(tx!.amount).toFixed(2)).toBe('50.00');
    });

    it('marks the description so the partial state is visible in a report', async () => {
      await service.updateAppointmentPayment(CLINIC, OWNER, APPOINTMENT, {
        paymentStatus: 'PARTIALLY_PAID',
        paidAmountCents: 5_000,
      } as never);

      const tx = await linkedTransaction();
      expect(tx!.description).toContain('[Parcial]');
    });
  });

  // ── Back to pending, refunded, cancelled ───────────────────────────────────

  describe('reversing a payment', () => {
    it('returns the transaction to pending and clears the paid timestamp', async () => {
      await service.updateAppointmentPayment(CLINIC, OWNER, APPOINTMENT, {
        paymentStatus: 'PAID',
        paidAmountCents: 10_000,
      } as never);
      await service.updateAppointmentPayment(CLINIC, OWNER, APPOINTMENT, {
        paymentStatus: 'PAYMENT_PENDING',
      } as never);

      const tx = await linkedTransaction();

      expect(tx!.status).toBe('PENDING');
      expect(tx!.paidAt).toBeNull();
      // The appointment's own paid amount is cleared, not left stale.
      const appointment = await h.prisma.appointment.findUniqueOrThrow({
        where: { id: APPOINTMENT },
      });
      expect(appointment.paidAmountCents).toBeNull();
    });

    it('creates nothing when an appointment that was never paid is set pending', async () => {
      await service.updateAppointmentPayment(CLINIC, OWNER, APPOINTMENT, {
        paymentStatus: 'PAYMENT_PENDING',
      } as never);

      await expect(linkedTransaction()).resolves.toBeNull();
    });

    it('cancels the transaction on a refund rather than deleting the record', async () => {
      await service.updateAppointmentPayment(CLINIC, OWNER, APPOINTMENT, {
        paymentStatus: 'PAID',
        paidAmountCents: 10_000,
      } as never);
      await service.updateAppointmentPayment(CLINIC, OWNER, APPOINTMENT, {
        paymentStatus: 'REFUNDED',
      } as never);

      const tx = await linkedTransaction();

      // The row survives: a refunded payment is history, not a mistake.
      expect(tx).not.toBeNull();
      expect(tx!.status).toBe('CANCELED');
    });

    it('cancels the transaction when the payment itself is cancelled', async () => {
      await service.updateAppointmentPayment(CLINIC, OWNER, APPOINTMENT, {
        paymentStatus: 'PAID',
        paidAmountCents: 10_000,
      } as never);
      await service.updateAppointmentPayment(CLINIC, OWNER, APPOINTMENT, {
        paymentStatus: 'CANCELED',
      } as never);

      const tx = await linkedTransaction();
      expect(tx!.status).toBe('CANCELED');
    });
  });

  // ── Category selection ─────────────────────────────────────────────────────

  describe('choosing the income category', () => {
    it('uses the category the caller names', async () => {
      const chosen = await createFinancialCategory(h.prisma, {
        id: 'cat-chosen',
        clinicId: CLINIC,
        type: 'INCOME',
        name: 'Ortodontia',
      });

      await service.updateAppointmentPayment(CLINIC, OWNER, APPOINTMENT, {
        paymentStatus: 'PAID',
        paidAmountCents: 10_000,
        categoryId: chosen.id,
      } as never);

      const tx = await linkedTransaction();
      expect(tx!.categoryId).toBe('cat-chosen');
    });

    it('refuses a category id that belongs to another clinic', async () => {
      await createFinancialCategory(h.prisma, {
        id: 'cat-foreign',
        clinicId: 'clinic-b',
        type: 'INCOME',
        name: 'Ortodontia',
      });

      await expect(
        service.updateAppointmentPayment(CLINIC, OWNER, APPOINTMENT, {
          paymentStatus: 'PAID',
          paidAmountCents: 10_000,
          categoryId: 'cat-foreign',
        } as never),
      ).rejects.toThrow(BadRequestException);

      // And nothing partial is left behind: the whole thing is one transaction.
      await expect(linkedTransaction()).resolves.toBeNull();
      const appointment = await h.prisma.appointment.findUniqueOrThrow({
        where: { id: APPOINTMENT },
      });
      expect(appointment.paymentStatus).not.toBe('PAID');
    });
  });

  // ── Guards ─────────────────────────────────────────────────────────────────

  describe('refusals', () => {
    it('rejects PAID with no amount', async () => {
      await expect(
        service.updateAppointmentPayment(CLINIC, OWNER, APPOINTMENT, {
          paymentStatus: 'PAID',
        } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a partial payment of zero', async () => {
      await expect(
        service.updateAppointmentPayment(CLINIC, OWNER, APPOINTMENT, {
          paymentStatus: 'PARTIALLY_PAID',
          paidAmountCents: 0,
        } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('reports an appointment from another clinic as not found', async () => {
      await createAppointment(h.prisma, {
        id: 'appt-foreign',
        clinicId: 'clinic-b',
        profileId: 'profile-b',
      });

      await expect(
        service.updateAppointmentPayment(CLINIC, OWNER, 'appt-foreign', {
          paymentStatus: 'PAID',
          paidAmountCents: 10_000,
        } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it('does not touch the other clinic’s appointment while refusing', async () => {
      await createAppointment(h.prisma, {
        id: 'appt-foreign',
        clinicId: 'clinic-b',
        profileId: 'profile-b',
      });

      await expect(
        service.updateAppointmentPayment(CLINIC, OWNER, 'appt-foreign', {
          paymentStatus: 'PAID',
          paidAmountCents: 10_000,
        } as never),
      ).rejects.toThrow(NotFoundException);

      const foreign = await h.prisma.appointment.findUniqueOrThrow({
        where: { id: 'appt-foreign' },
      });
      expect(foreign.paymentStatus).not.toBe('PAID');
      await expect(
        h.prisma.financialTransaction.count({
          where: { appointmentId: 'appt-foreign' },
        }),
      ).resolves.toBe(0);
    });
  });
});
