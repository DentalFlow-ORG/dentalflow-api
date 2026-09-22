import { ConflictException, NotFoundException } from '@nestjs/common';
import { ClinicalRecordsService } from '../../src/modules/clinical-records/clinical-records.service';
import { PatientsService } from '../../src/modules/patients/patients.service';
import {
  createIntegrationHarness,
  IntegrationHarness,
} from '../support/integration-harness';
import { createAppointment, seedTwoClinics } from '../support/factories';

/**
 * Patient identity against real PostgreSQL.
 *
 * DentalFlow has no Patient entity: identity is derived from the denormalized
 * patientEmail / patientName columns. These tests answer the only question
 * that decides whether that is survivable in production —
 *
 *   can data belonging to patient A be returned, modified or overwritten
 *   while the clinic is operating on patient B?
 *
 * They run against the genuine database so collation, NULL semantics and the
 * actual UPDATE are exercised, not a mock's idea of them.
 */

const CLINIC = 'clinic-a';
const OWNER = 'owner-a';

describe('Patient identity (PostgreSQL)', () => {
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

  // -- One person, several spellings ---------------------------------------

  describe('a single patient recorded inconsistently', () => {
    it('keeps one identity when the email casing varied across visits', async () => {
      await createAppointment(h.prisma, {
        id: 'a1',
        patientEmail: 'Maria@Example.test',
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

    it('keeps one identity when the email had surrounding whitespace', async () => {
      await createAppointment(h.prisma, {
        id: 'a1',
        patientEmail: ' maria@example.test ',
      });
      await createAppointment(h.prisma, {
        id: 'a2',
        patientEmail: 'maria@example.test',
        appointmentDate: new Date(Date.UTC(2026, 5, 16)),
      });

      expect((await patients.listPatients(CLINIC)).data).toHaveLength(1);
    });

    it('returns the whole history for any spelling the caller sends', async () => {
      await createAppointment(h.prisma, {
        id: 'a1',
        patientEmail: 'Maria@Example.test',
      });
      await createAppointment(h.prisma, {
        id: 'a2',
        patientEmail: 'maria@example.test',
        appointmentDate: new Date(Date.UTC(2026, 5, 16)),
      });

      const history = await patients.getPatientHistory(
        CLINIC,
        'MARIA@EXAMPLE.TEST',
      );

      expect(history.appointments).toHaveLength(2);
    });

    it('keeps one identity when the name was typed differently', async () => {
      await createAppointment(h.prisma, {
        id: 'a1',
        patientName: 'Maria Silva',
        patientEmail: 'maria@example.test',
      });
      await createAppointment(h.prisma, {
        id: 'a2',
        patientName: 'maria silva',
        patientEmail: 'maria@example.test',
        appointmentDate: new Date(Date.UTC(2026, 5, 16)),
      });

      expect((await patients.listPatients(CLINIC)).data).toHaveLength(1);
    });
  });

  // -- Two people, one name, no email --------------------------------------

  describe('two homonyms with no email (containment guard)', () => {
    beforeEach(async () => {
      await createAppointment(h.prisma, {
        id: 'a1',
        patientName: 'Joao Souza',
        patientEmail: null,
      });
      await h.prisma.appointment.update({
        where: { id: 'a1' },
        data: { patientPhone: '11999990000' },
      });
      await createAppointment(h.prisma, {
        id: 'a2',
        patientName: 'Joao Souza',
        patientEmail: null,
        appointmentDate: new Date(Date.UTC(2026, 5, 16)),
      });
      await h.prisma.appointment.update({
        where: { id: 'a2' },
        data: { patientPhone: '11888880000' },
      });
    });

    it('refuses to read a clinical timeline it cannot attribute', async () => {
      await expect(
        records.getPatientTimeline(CLINIC, OWNER, 'OWNER', 'Joao Souza'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses to read an odontogram it cannot attribute', async () => {
      await expect(
        records.getOdontogram(CLINIC, OWNER, 'OWNER', 'Joao Souza'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses to write an odontogram it cannot attribute', async () => {
      await expect(
        records.upsertOdontogram(
          CLINIC,
          OWNER,
          'OWNER',
          'Joao Souza',
          'Joao Souza',
          { teeth: {} },
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(await h.prisma.odontogramRecord.count()).toBe(0);
    });

    it('stays usable for a homonym-free patient in the same clinic', async () => {
      // The guard must not make ordinary charting fail.
      await createAppointment(h.prisma, {
        id: 'a3',
        patientName: 'Clara Dias',
        patientEmail: null,
        appointmentDate: new Date(Date.UTC(2026, 5, 17)),
      });

      await expect(
        records.upsertOdontogram(
          CLINIC,
          OWNER,
          'OWNER',
          'Clara Dias',
          'Clara Dias',
          { teeth: { 11: 'CARIES' } },
        ),
      ).resolves.toBeDefined();
    });
  });

  // -- Two people, one shared email ----------------------------------------

  describe('two patients sharing one email address', () => {
    // A parent booking themselves and a child under one household address is
    // ordinary clinic behaviour, not an edge case.
    beforeEach(async () => {
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
    });

    it('refuses to read a clinical timeline it cannot attribute', async () => {
      await expect(
        records.getPatientTimeline(
          CLINIC,
          OWNER,
          'OWNER',
          'familia@example.test',
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses to read an odontogram it cannot attribute', async () => {
      await expect(
        records.getOdontogram(CLINIC, OWNER, 'OWNER', 'familia@example.test'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('does not overwrite one patient dental chart when charting the other', async () => {
      // Regression for the destructive case: upsert used to resolve the shared
      // email to the first patient's row and UPDATE it in place, destroying
      // their chart. Charting the second patient must now fail instead.
      await h.prisma.appointment.delete({ where: { id: 'a2' } });
      await records.upsertOdontogram(
        CLINIC,
        OWNER,
        'OWNER',
        'familia@example.test',
        'Marta Lima',
        { teeth: { 11: 'CARIES' } },
      );

      // The household's second patient appears; the address is now ambiguous.
      await createAppointment(h.prisma, {
        id: 'a2',
        patientName: 'Pedro Lima',
        patientEmail: 'familia@example.test',
        appointmentDate: new Date(Date.UTC(2026, 5, 16)),
      });

      await expect(
        records.upsertOdontogram(
          CLINIC,
          OWNER,
          'OWNER',
          'familia@example.test',
          'Pedro Lima',
          { teeth: { 36: 'EXTRACTED' } },
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      const charts = await h.prisma.odontogramRecord.findMany();
      expect(charts).toHaveLength(1);
      expect(charts[0].data).toEqual({ teeth: { 11: 'CARIES' } });
    });

    it('keeps the unresolved list visible but refuses ambiguous history', async () => {
      expect((await patients.listPatients(CLINIC)).data).toHaveLength(1);
      await expect(
        patients.getPatientHistory(CLINIC, 'familia@example.test'),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // -- Stable identity: the acceptance criterion ---------------------------

  describe('two patients sharing name, email AND phone', () => {
    // The case containment could never reach: every discriminating column is
    // identical, so only a stable identity can keep these two people apart.
    // Before the Patient entity this scenario returned one patient, one chart,
    // and charting the second destroyed the first one's chart.
    const NAME = 'Jose Silva';
    const EMAIL = 'jose@example.test';
    const PHONE = '11999990000';

    let patientA: string;
    let patientB: string;

    beforeEach(async () => {
      const a = await h.prisma.patient.create({
        data: { clinicId: CLINIC, name: NAME, email: EMAIL, phone: PHONE },
      });
      const b = await h.prisma.patient.create({
        data: { clinicId: CLINIC, name: NAME, email: EMAIL, phone: PHONE },
      });
      patientA = a.id;
      patientB = b.id;

      await createAppointment(h.prisma, {
        id: 'a1',
        patientName: NAME,
        patientEmail: EMAIL,
      });
      await createAppointment(h.prisma, {
        id: 'a2',
        patientName: NAME,
        patientEmail: EMAIL,
        appointmentDate: new Date(Date.UTC(2026, 5, 16)),
      });
      await h.prisma.appointment.update({
        where: { id: 'a1' },
        data: { patientId: patientA, patientPhone: PHONE },
      });
      await h.prisma.appointment.update({
        where: { id: 'a2' },
        data: { patientId: patientB, patientPhone: PHONE },
      });
    });

    it('keeps them as two distinct identities', async () => {
      expect(patientA).not.toBe(patientB);

      const list = await patients.listPatients(CLINIC);
      expect(list.data).toHaveLength(2);
      expect(list.data.map((p) => p.patientId).sort()).toEqual(
        [patientA, patientB].sort(),
      );
    });

    it('keeps appointment histories separate', async () => {
      const a = await patients.getPatientHistory(CLINIC, EMAIL, patientA);
      const b = await patients.getPatientHistory(CLINIC, EMAIL, patientB);

      expect(a.appointments.map((x) => x.id)).toEqual(['a1']);
      expect(b.appointments.map((x) => x.id)).toEqual(['a2']);
    });

    it('does not let B read A odontogram, and does not overwrite it', async () => {
      await records.upsertOdontogram(
        CLINIC,
        OWNER,
        'OWNER',
        EMAIL,
        NAME,
        { teeth: { 11: 'CARIES' } },
        patientA,
      );
      await records.upsertOdontogram(
        CLINIC,
        OWNER,
        'OWNER',
        EMAIL,
        NAME,
        { teeth: { 36: 'EXTRACTED' } },
        patientB,
      );

      const chartA = await records.getOdontogram(
        CLINIC,
        OWNER,
        'OWNER',
        EMAIL,
        patientA,
      );
      const chartB = await records.getOdontogram(
        CLINIC,
        OWNER,
        'OWNER',
        EMAIL,
        patientB,
      );

      expect(chartA?.data).toEqual({ teeth: { 11: 'CARIES' } });
      expect(chartB?.data).toEqual({ teeth: { 36: 'EXTRACTED' } });
      expect(await h.prisma.odontogramRecord.count()).toBe(2);
    });

    it('keeps clinical timelines separate', async () => {
      await h.prisma.clinicalRecord.createMany({
        data: [
          {
            id: 'rec-a',
            clinicId: CLINIC,
            profileId: 'profile-a',
            patientId: patientA,
            patientName: NAME,
            patientEmail: EMAIL,
            createdByUserId: OWNER,
          },
          {
            id: 'rec-b',
            clinicId: CLINIC,
            profileId: 'profile-a',
            patientId: patientB,
            patientName: NAME,
            patientEmail: EMAIL,
            createdByUserId: OWNER,
          },
        ],
      });

      const a = await records.getPatientTimeline(
        CLINIC,
        OWNER,
        'OWNER',
        EMAIL,
        patientA,
      );
      const b = await records.getPatientTimeline(
        CLINIC,
        OWNER,
        'OWNER',
        EMAIL,
        patientB,
      );

      expect(a.records.map((r) => r.id)).toEqual(['rec-a']);
      expect(b.records.map((r) => r.id)).toEqual(['rec-b']);
    });

    it('keeps avatars separate', async () => {
      await patients.upsertPatientAvatar(CLINIC, EMAIL, 'data:A', patientA);
      await patients.upsertPatientAvatar(CLINIC, EMAIL, 'data:B', patientB);

      await expect(
        patients.getPatientAvatar(CLINIC, EMAIL, patientA),
      ).resolves.toEqual({ avatarUrl: 'data:A' });
      await expect(
        patients.getPatientAvatar(CLINIC, EMAIL, patientB),
      ).resolves.toEqual({ avatarUrl: 'data:B' });
    });
  });

  // -- Identity survives attribute changes ---------------------------------

  describe('a patient whose contact details change', () => {
    it('keeps one identity across an email and phone change', async () => {
      const patient = await h.prisma.patient.create({
        data: {
          clinicId: CLINIC,
          name: 'Ana Costa',
          email: 'ana@old.test',
          phone: '11999990000',
        },
      });

      await createAppointment(h.prisma, {
        id: 'a1',
        patientEmail: 'ana@old.test',
        patientName: 'Ana Costa',
      });
      await createAppointment(h.prisma, {
        id: 'a2',
        patientEmail: 'ana@new.test',
        patientName: 'Ana Costa Souza',
        appointmentDate: new Date(Date.UTC(2026, 5, 16)),
      });
      await h.prisma.appointment.updateMany({
        where: { clinicId: CLINIC },
        data: { patientId: patient.id },
      });

      // One identity, whole history, despite every attribute differing.
      const list = await patients.listPatients(CLINIC);
      expect(list.data).toHaveLength(1);
      expect(list.data[0].totalAppointments).toBe(2);

      const history = await patients.getPatientHistory(
        CLINIC,
        'ana@old.test',
        patient.id,
      );
      expect(history.appointments).toHaveLength(2);
    });
  });

  // -- Tenant isolation ----------------------------------------------------

  describe('cross-tenant access', () => {
    it('refuses a patient id that belongs to another clinic', async () => {
      const foreign = await h.prisma.patient.create({
        data: { clinicId: 'clinic-b', name: 'Beta Patient' },
      });

      // Knowing the id is not enough; the clinic is part of the lookup.
      await expect(
        records.getOdontogram(
          CLINIC,
          OWNER,
          'OWNER',
          'x@example.test',
          foreign.id,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses a foreign patient id on the clinical timeline', async () => {
      const foreign = await h.prisma.patient.create({
        data: { clinicId: 'clinic-b', name: 'Beta Patient' },
      });

      await expect(
        records.getPatientTimeline(
          CLINIC,
          OWNER,
          'OWNER',
          'x@example.test',
          foreign.id,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('never returns another clinic appointments through a local patient', async () => {
      const local = await h.prisma.patient.create({
        data: { clinicId: CLINIC, name: 'Alpha Patient' },
      });
      await createAppointment(h.prisma, {
        id: 'b1',
        clinicId: 'clinic-b',
        profileId: 'profile-b',
        patientName: 'Alpha Patient',
      });

      const history = await patients.getPatientHistory(
        CLINIC,
        'Alpha Patient',
        local.id,
      );
      expect(history.appointments).toHaveLength(0);
    });
  });
});
