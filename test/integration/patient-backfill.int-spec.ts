import type { PrismaClient } from '@prisma/client';
import {
  backfillRecordsFromAppointments,
  collect,
  emptyCounts,
} from '../../scripts/backfill-patient-identity';
import {
  createIntegrationHarness,
  IntegrationHarness,
} from '../support/integration-harness';
import { createAppointment, seedTwoClinics } from '../support/factories';

/**
 * The backfill, against real PostgreSQL.
 *
 * What matters here is mostly what the backfill refuses to do. Assigning one
 * patient to rows that merely share a name, an email or a phone would rebuild
 * the original defect underneath the new table, so identity is only ever taken
 * from a relationship the database already guarantees. Everything else is left
 * NULL and counted, not guessed.
 */

const CLINIC = 'clinic-a';

describe('Patient identity backfill (PostgreSQL)', () => {
  let h: IntegrationHarness;
  let prisma: PrismaClient;

  beforeAll(async () => {
    h = await createIntegrationHarness();
    prisma = h.prisma;
  }, 60000);

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await h.truncate();
    await seedTwoClinics(prisma);
  });

  async function run() {
    const counts = emptyCounts();
    await backfillRecordsFromAppointments(prisma, counts, true);
    return counts;
  }

  describe('legacy appointments are never assigned automatically', () => {
    it('leaves appointments quarantined even when they share an account', async () => {
      // `patientUserId` is a login account, not a person. Nothing in the data
      // proves who a legacy appointment was for, so none of them is assigned.
      await createAppointment(h.prisma, { id: 'a1' });
      await createAppointment(h.prisma, {
        id: 'a2',
        appointmentDate: new Date(Date.UTC(2026, 5, 16)),
      });
      await prisma.appointment.updateMany({
        where: { clinicId: CLINIC },
        data: { patientUserId: 'dentist-a' },
      });

      await run();

      const rows = await prisma.appointment.findMany({
        select: { patientId: true },
      });
      expect(rows.every((a) => a.patientId === null)).toBe(true);
      expect(await prisma.patient.count()).toBe(0);
    });

    it('creates no Patient rows of its own', async () => {
      // The script reports and propagates; it never invents an identity.
      await createAppointment(h.prisma, { id: 'a1' });
      await prisma.appointment.updateMany({
        data: { patientUserId: 'dentist-a' },
      });

      const counts = await run();

      expect(counts.patientsCreated).toBe(0);
      expect(counts.appointments.assigned).toBe(0);
    });
  });

  describe('contact values never establish identity', () => {
    it('leaves two people sharing name, email and phone unassigned', async () => {
      // The decisive refusal. Every contact column matches, and the backfill
      // must still not claim these are one person.
      await createAppointment(h.prisma, {
        id: 'a1',
        patientName: 'Jose Silva',
        patientEmail: 'jose@x.test',
      });
      await createAppointment(h.prisma, {
        id: 'a2',
        patientName: 'Jose Silva',
        patientEmail: 'jose@x.test',
        appointmentDate: new Date(Date.UTC(2026, 5, 16)),
      });
      await prisma.appointment.updateMany({
        data: { patientPhone: '11999990000' },
      });

      const counts = await run();

      expect(counts.appointments.assigned).toBe(0);
      expect(counts.patientsCreated).toBe(0);
      expect(await prisma.patient.count()).toBe(0);

      const after = await collect(prisma);
      expect(after.appointments.unresolved).toBe(2);
    });

    it('never assigns a standalone odontogram', async () => {
      // Odontograms carry no FK to anything, so nothing can prove ownership.
      await prisma.odontogramRecord.create({
        data: {
          clinicId: CLINIC,
          patientName: 'Jose Silva',
          patientEmail: 'jose@x.test',
          data: {},
          createdByUserId: 'owner-a',
        },
      });

      await run();

      const after = await collect(prisma);
      expect(after.odontograms.unresolved).toBe(1);
      expect(after.odontograms.assigned).toBe(0);
    });
  });

  describe('RECORD_FROM_APPT — records follow their appointment FK', () => {
    it('inherits identity from the linked appointment', async () => {
      // The appointment's identity comes from dual-write or from an operator
      // reconciling it; the script only propagates it along the FK.
      const patient = await prisma.patient.create({
        data: { clinicId: CLINIC, name: 'Maria Silva' },
      });
      await createAppointment(h.prisma, { id: 'a1' });
      await prisma.appointment.update({
        where: { id: 'a1' },
        data: { patientId: patient.id },
      });
      await prisma.clinicalRecord.create({
        data: {
          id: 'rec-1',
          clinicId: CLINIC,
          appointmentId: 'a1',
          profileId: 'profile-a',
          patientName: 'Maria Silva',
          createdByUserId: 'owner-a',
        },
      });

      await run();

      const appointment = await prisma.appointment.findUniqueOrThrow({
        where: { id: 'a1' },
      });
      const record = await prisma.clinicalRecord.findUniqueOrThrow({
        where: { id: 'rec-1' },
      });
      expect(record.patientId).toBe(appointment.patientId);
      expect(record.patientId).not.toBeNull();
    });

    it('leaves a record with no appointment unassigned', async () => {
      await prisma.clinicalRecord.create({
        data: {
          id: 'rec-orphan',
          clinicId: CLINIC,
          profileId: 'profile-a',
          patientName: 'Maria Silva',
          patientEmail: 'maria@x.test',
          createdByUserId: 'owner-a',
        },
      });

      await run();

      const record = await prisma.clinicalRecord.findUniqueOrThrow({
        where: { id: 'rec-orphan' },
      });
      expect(record.patientId).toBeNull();
    });
  });

  describe('integrity', () => {
    it('is idempotent — a second run creates no additional patients', async () => {
      await createAppointment(h.prisma, { id: 'a1' });
      await prisma.appointment.updateMany({
        data: { patientUserId: 'dentist-a' },
      });

      await run();
      const afterFirst = await prisma.patient.count();
      await run();

      expect(await prisma.patient.count()).toBe(afterFirst);
    });

    it('changes no row counts and leaves no orphan patientId', async () => {
      await createAppointment(h.prisma, { id: 'a1' });
      await prisma.appointment.updateMany({
        data: { patientUserId: 'dentist-a' },
      });
      const before = await collect(prisma);

      await run();
      const after = await collect(prisma);

      expect(after.appointments.total).toBe(before.appointments.total);
      expect(after.clinicalRecords.total).toBe(before.clinicalRecords.total);

      // Every assigned patientId resolves to a patient in the same clinic.
      const orphans = await prisma.appointment.findMany({
        where: { patientId: { not: null }, patientRecord: null },
      });
      expect(orphans).toHaveLength(0);
    });
  });
});
