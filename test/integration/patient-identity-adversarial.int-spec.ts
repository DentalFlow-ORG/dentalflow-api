import { NotFoundException } from '@nestjs/common';
import { ClinicalRecordsService } from '../../src/modules/clinical-records/clinical-records.service';
import { PatientsService } from '../../src/modules/patients/patients.service';
import {
  backfillRecordsFromAppointments,
  emptyCounts,
} from '../../scripts/backfill-patient-identity';
import {
  createIntegrationHarness,
  IntegrationHarness,
} from '../support/integration-harness';
import { createAppointment, seedTwoClinics } from '../support/factories';

/**
 * Adversarial review of the stable-identity migration.
 *
 * These tests exist to falsify the migration's claims, not to confirm them.
 * Each one describes an attack on the identity boundary; a passing test means
 * the attack failed.
 */

const CLINIC = 'clinic-a';
const OWNER = 'owner-a';

describe('Patient identity — adversarial', () => {
  let h: IntegrationHarness;
  let patients: PatientsService;
  let records: ClinicalRecordsService;

  beforeAll(async () => {
    h = await createIntegrationHarness();
    patients = h.app.get(PatientsService);
    records = h.app.get(ClinicalRecordsService);
  }, 60000);

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await h.truncate();
    await seedTwoClinics(h.prisma);
  });

  // -- Attack: reach another tenant through a known patient id --------------

  describe('cross-tenant writes', () => {
    it('does not let a clinic attach an avatar to another clinic patient', async () => {
      const foreign = await h.prisma.patient.create({
        data: { clinicId: 'clinic-b', name: 'Beta Patient' },
      });

      await expect(
        patients.upsertPatientAvatar(
          CLINIC,
          'x@example.test',
          'data:evil',
          foreign.id,
        ),
      ).rejects.toBeDefined();

      // Nothing may be written against a patient this clinic cannot address.
      expect(
        await h.prisma.patientAvatar.count({
          where: { patientId: foreign.id },
        }),
      ).toBe(0);
    });

    it('does not read another clinic avatar with a known patient id', async () => {
      const foreign = await h.prisma.patient.create({
        data: { clinicId: 'clinic-b', name: 'Beta Patient' },
      });
      await h.prisma.patientAvatar.create({
        data: {
          clinicId: 'clinic-b',
          patientId: foreign.id,
          identifier: foreign.id,
          avatarUrl: 'data:secret',
        },
      });

      await expect(
        patients.getPatientAvatar(CLINIC, 'x@example.test', foreign.id),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('does not return another clinic appointments with a known patient id', async () => {
      const foreign = await h.prisma.patient.create({
        data: { clinicId: 'clinic-b', name: 'Beta Patient' },
      });
      await createAppointment(h.prisma, {
        id: 'b1',
        clinicId: 'clinic-b',
        profileId: 'profile-b',
      });
      await h.prisma.appointment.update({
        where: { id: 'b1' },
        data: { patientId: foreign.id },
      });

      await expect(
        patients.getPatientHistory(CLINIC, 'x@example.test', foreign.id),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // -- Attack: make the backfill merge two people ---------------------------

  describe('backfill cannot merge two people', () => {
    async function runBackfill() {
      const counts = emptyCounts();
      await backfillRecordsFromAppointments(h.prisma, counts, true);
      return counts;
    }

    it('leaves dependants booked under one household account unassigned', async () => {
      // Two people, one household login. Nothing proves who each appointment
      // was for, so neither is given an identity.
      await createAppointment(h.prisma, {
        id: 'a1',
        patientName: 'Marta Lima',
        patientEmail: 'familia@example.test',
      });
      await createAppointment(h.prisma, {
        id: 'a2',
        patientName: 'Pedro Lima',
        patientEmail: 'familia@example.test',
        appointmentDate: new Date(Date.UTC(2026, 5, 16)),
      });
      await h.prisma.appointment.updateMany({
        where: { clinicId: CLINIC },
        data: { patientUserId: 'dentist-a' },
      });

      await runBackfill();

      const rows = await h.prisma.appointment.findMany({
        where: { clinicId: CLINIC },
        select: { patientId: true },
      });
      expect(rows.every((a) => a.patientId === null)).toBe(true);
    });

    it('never overwrites an identity that was already assigned', async () => {
      const explicit = await h.prisma.patient.create({
        data: { clinicId: CLINIC, name: 'Already Assigned' },
      });
      await createAppointment(h.prisma, { id: 'a1' });
      await h.prisma.appointment.update({
        where: { id: 'a1' },
        data: { patientUserId: 'dentist-a', patientId: explicit.id },
      });

      await runBackfill();

      const appointment = await h.prisma.appointment.findUniqueOrThrow({
        where: { id: 'a1' },
      });
      expect(appointment.patientId).toBe(explicit.id);
    });
  });

  // -- Attack: recreate the original corruption through the service path ----

  describe('the original odontogram corruption', () => {
    const NAME = 'Maria Silva';
    const EMAIL = 'familia@example.test';
    const PHONE = '61999999999';

    it('cannot be reproduced in either write order', async () => {
      const a = await h.prisma.patient.create({
        data: { clinicId: CLINIC, name: NAME, email: EMAIL, phone: PHONE },
      });
      const b = await h.prisma.patient.create({
        data: { clinicId: CLINIC, name: NAME, email: EMAIL, phone: PHONE },
      });

      // B first, then A — the reverse of the order the fix was written for.
      await records.upsertOdontogram(
        CLINIC,
        OWNER,
        'OWNER',
        EMAIL,
        NAME,
        { teeth: { 36: 'B' } },
        b.id,
      );
      await records.upsertOdontogram(
        CLINIC,
        OWNER,
        'OWNER',
        EMAIL,
        NAME,
        { teeth: { 11: 'A' } },
        a.id,
      );
      // Then update B again, which is the destructive step in the old model.
      await records.upsertOdontogram(
        CLINIC,
        OWNER,
        'OWNER',
        EMAIL,
        NAME,
        { teeth: { 36: 'B2' } },
        b.id,
      );

      const chartA = await records.getOdontogram(
        CLINIC,
        OWNER,
        'OWNER',
        EMAIL,
        a.id,
      );
      const chartB = await records.getOdontogram(
        CLINIC,
        OWNER,
        'OWNER',
        EMAIL,
        b.id,
      );

      expect(chartA?.data).toEqual({ teeth: { 11: 'A' } });
      expect(chartB?.data).toEqual({ teeth: { 36: 'B2' } });
      expect(await h.prisma.odontogramRecord.count()).toBe(2);
    });

    it('keeps charts apart when the shared contact values also match legacy rows', async () => {
      // A legacy odontogram with no identity sits on the same contact values.
      // It must not be captured by either stable patient.
      await h.prisma.odontogramRecord.create({
        data: {
          clinicId: CLINIC,
          patientName: NAME,
          patientEmail: EMAIL,
          data: { teeth: { 21: 'LEGACY' } },
          createdByUserId: OWNER,
        },
      });
      const a = await h.prisma.patient.create({
        data: { clinicId: CLINIC, name: NAME, email: EMAIL, phone: PHONE },
      });

      await records.upsertOdontogram(
        CLINIC,
        OWNER,
        'OWNER',
        EMAIL,
        NAME,
        { teeth: { 11: 'A' } },
        a.id,
      );

      const chartA = await records.getOdontogram(
        CLINIC,
        OWNER,
        'OWNER',
        EMAIL,
        a.id,
      );
      expect(chartA?.data).toEqual({ teeth: { 11: 'A' } });

      // The legacy row is untouched.
      const legacy = await h.prisma.odontogramRecord.findFirst({
        where: { clinicId: CLINIC, patientId: null },
      });
      expect(legacy?.data).toEqual({ teeth: { 21: 'LEGACY' } });
    });
  });

  // -- Attack: delete the identity and fall back to contact matching --------

  describe('patient deletion', () => {
    it('records what a hard delete does to clinical identity', async () => {
      const a = await h.prisma.patient.create({
        data: { clinicId: CLINIC, name: 'Maria', email: 'm@x.test' },
      });
      await h.prisma.odontogramRecord.create({
        data: {
          clinicId: CLINIC,
          patientId: a.id,
          patientName: 'Maria',
          patientEmail: 'm@x.test',
          data: { teeth: { 11: 'A' } },
          createdByUserId: OWNER,
        },
      });

      await h.prisma.patient.delete({ where: { id: a.id } });

      // ON DELETE SET NULL detaches the chart and returns it to the legacy
      // contact-matching path. The row survives — nothing is destroyed — but it
      // no longer has stable identity.
      const chart = await h.prisma.odontogramRecord.findFirstOrThrow({
        where: { clinicId: CLINIC },
      });
      expect(chart.patientId).toBeNull();
      expect(chart.patientName).toBe('Maria');
    });

    it('hides a soft-deleted patient from clinical reads', async () => {
      const a = await h.prisma.patient.create({
        data: {
          clinicId: CLINIC,
          name: 'Maria',
          email: 'm@x.test',
          deletedAt: new Date(),
        },
      });

      await expect(
        records.getOdontogram(CLINIC, OWNER, 'OWNER', 'm@x.test', a.id),
      ).rejects.toBeDefined();
    });
  });

  // -- Identity must follow patientId, never the contact tuple --------------

  describe('identity follows patientId', () => {
    it.each([
      [
        'same name only',
        { name: 'Same Name', email: null, phone: '111' },
        { name: 'Same Name', email: null, phone: '222' },
      ],
      [
        'same email only',
        { name: 'A', email: 'same@x.test', phone: '111' },
        { name: 'B', email: 'same@x.test', phone: '222' },
      ],
      [
        'same phone only',
        { name: 'A', email: 'a@x.test', phone: '111' },
        { name: 'B', email: 'b@x.test', phone: '111' },
      ],
      [
        'name + email',
        { name: 'Same', email: 'same@x.test', phone: '111' },
        { name: 'Same', email: 'same@x.test', phone: '222' },
      ],
      [
        'name + phone',
        { name: 'Same', email: 'a@x.test', phone: '111' },
        { name: 'Same', email: 'b@x.test', phone: '111' },
      ],
      [
        'email + phone',
        { name: 'A', email: 'same@x.test', phone: '111' },
        { name: 'B', email: 'same@x.test', phone: '111' },
      ],
      [
        'everything',
        { name: 'Same', email: 'same@x.test', phone: '111' },
        { name: 'Same', email: 'same@x.test', phone: '111' },
      ],
      [
        'no email',
        { name: 'Same', email: null, phone: '111' },
        { name: 'Same', email: null, phone: '111' },
      ],
      [
        'no phone',
        { name: 'Same', email: 'same@x.test', phone: null },
        { name: 'Same', email: 'same@x.test', phone: null },
      ],
      [
        'no optional fields',
        { name: 'Same', email: null, phone: null },
        { name: 'Same', email: null, phone: null },
      ],
    ])(
      'keeps charts separate for two patients with %s',
      async (_label, a, b) => {
        const pa = await h.prisma.patient.create({
          data: { clinicId: CLINIC, ...a },
        });
        const pb = await h.prisma.patient.create({
          data: { clinicId: CLINIC, ...b },
        });
        const id = a.email ?? a.name;

        await records.upsertOdontogram(
          CLINIC,
          OWNER,
          'OWNER',
          id,
          a.name,
          { teeth: { 11: 'A' } },
          pa.id,
        );
        await records.upsertOdontogram(
          CLINIC,
          OWNER,
          'OWNER',
          b.email ?? b.name,
          b.name,
          { teeth: { 36: 'B' } },
          pb.id,
        );

        const chartA = await records.getOdontogram(
          CLINIC,
          OWNER,
          'OWNER',
          id,
          pa.id,
        );
        const chartB = await records.getOdontogram(
          CLINIC,
          OWNER,
          'OWNER',
          b.email ?? b.name,
          pb.id,
        );

        expect(chartA?.data).toEqual({ teeth: { 11: 'A' } });
        expect(chartB?.data).toEqual({ teeth: { 36: 'B' } });
      },
    );

    it('survives an email change on one of two identical patients', async () => {
      const pa = await h.prisma.patient.create({
        data: { clinicId: CLINIC, name: 'Same', email: 'same@x.test' },
      });
      const pb = await h.prisma.patient.create({
        data: { clinicId: CLINIC, name: 'Same', email: 'same@x.test' },
      });
      await records.upsertOdontogram(
        CLINIC,
        OWNER,
        'OWNER',
        'same@x.test',
        'Same',
        { teeth: { 11: 'A' } },
        pa.id,
      );

      await h.prisma.patient.update({
        where: { id: pa.id },
        data: { email: 'moved@x.test', phone: '999' },
      });

      // Identity is the id, so the chart is still reachable under the new
      // address and still not reachable through the other patient.
      const chartA = await records.getOdontogram(
        CLINIC,
        OWNER,
        'OWNER',
        'moved@x.test',
        pa.id,
      );
      expect(chartA?.data).toEqual({ teeth: { 11: 'A' } });

      const chartB = await records.getOdontogram(
        CLINIC,
        OWNER,
        'OWNER',
        'same@x.test',
        pb.id,
      );
      expect(chartB).toBeNull();
    });

    it('resolves legacy mixed-case and padded emails to one identity', async () => {
      await createAppointment(h.prisma, {
        id: 'a1',
        patientEmail: ' Maria@Example.TEST ',
      });
      await createAppointment(h.prisma, {
        id: 'a2',
        patientEmail: 'maria@example.test',
        appointmentDate: new Date(Date.UTC(2026, 5, 16)),
      });

      const list = await patients.listPatients(CLINIC);
      expect(list.data).toHaveLength(1);
      expect(list.data[0].totalAppointments).toBe(2);
    });
  });
});
