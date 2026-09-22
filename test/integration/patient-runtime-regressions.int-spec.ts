import { ConflictException } from '@nestjs/common';
import { ClinicalRecordsService } from '../../src/modules/clinical-records/clinical-records.service';
import { PatientsService } from '../../src/modules/patients/patients.service';
import { AppointmentsService } from '../../src/modules/appointments/appointments.service';
import { PatientResolverService } from '../../src/common/services/patient-resolver.service';
import {
  backfillRecordsFromAppointments,
  emptyCounts,
  collect,
} from '../../scripts/backfill-patient-identity';
import {
  createIntegrationHarness,
  IntegrationHarness,
} from '../support/integration-harness';
import { createAppointment, seedTwoClinics } from '../support/factories';

const CLINIC = 'clinic-a';
const NAME = 'Same Name';
const EMAIL = 'household@example.test';
const PHONE = '11999990000';

describe('Stable Patient runtime regressions (PostgreSQL)', () => {
  let h: IntegrationHarness;
  let clinical: ClinicalRecordsService;
  let patients: PatientsService;
  let appointments: AppointmentsService;
  let resolver: PatientResolverService;
  beforeAll(async () => {
    h = await createIntegrationHarness();
    clinical = h.app.get(ClinicalRecordsService);
    patients = h.app.get(PatientsService);
    appointments = h.app.get(AppointmentsService);
    resolver = h.app.get(PatientResolverService);
  }, 60000);
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.truncate();
    await seedTwoClinics(h.prisma);
  });

  const createPatient = (id: string, clinicId = CLINIC) =>
    h.prisma.patient.create({
      data: { id, clinicId, name: NAME, email: EMAIL, phone: PHONE },
    });
  async function booking(id: string, patientId: string | null) {
    await createAppointment(h.prisma, {
      id,
      patientName: NAME,
      patientEmail: EMAIL,
    });
    return h.prisma.appointment.update({
      where: { id },
      data: { patientId, patientPhone: PHONE },
    });
  }
  const chart = (patientId: string, marker: string) =>
    clinical.upsertOdontogram(
      CLINIC,
      'owner-a',
      'OWNER',
      EMAIL,
      NAME,
      { marker },
      patientId,
    );
  async function record(
    id: string,
    patientId: string | null,
    appointmentId?: string,
  ) {
    return h.prisma.clinicalRecord.create({
      data: {
        id,
        clinicId: CLINIC,
        patientId,
        appointmentId,
        profileId: 'profile-a',
        patientName: NAME,
        patientEmail: EMAIL,
        patientPhone: PHONE,
        clinicalEvolution: 'Independent evolution',
        createdByUserId: 'owner-a',
      },
    });
  }
  async function backfill(apply: boolean) {
    const counts = emptyCounts();
    await backfillRecordsFromAppointments(h.prisma, counts, apply);
    return counts;
  }
  async function pair() {
    for (const id of ['A', 'B']) {
      await createPatient(id);
      await booking('appt-' + id, id);
      await record('record-' + id, id, 'appt-' + id);
      await chart(id, id);
    }
  }

  it.each([
    ['A', 'B'],
    ['B', 'A'],
  ])(
    'completes %s then %s without exchanging snapshots',
    async (first, second) => {
      await pair();
      for (const id of [first, second]) {
        const completed = await clinical.completeRecord(
          CLINIC,
          'owner-a',
          'OWNER',
          'record-' + id,
        );
        expect(completed.odontogramSnapshot).toEqual({ marker: id });
      }
    },
  );
  it('refuses ambiguous identifier reads and writes without touching stable charts', async () => {
    await pair();
    await expect(
      clinical.upsertOdontogram(CLINIC, 'owner-a', 'OWNER', EMAIL, NAME, {
        marker: 'wrong',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      clinical.getPatientTimeline(CLINIC, 'owner-a', 'OWNER', EMAIL),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      patients.getPatientHistory(CLINIC, EMAIL),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      patients.upsertPatientAvatar(CLINIC, EMAIL, 'wrong'),
    ).rejects.toBeInstanceOf(ConflictException);
    for (const id of ['A', 'B'])
      expect(
        (await clinical.getOdontogram(CLINIC, 'owner-a', 'OWNER', EMAIL, id))
          ?.data,
      ).toEqual({ marker: id });
  });
  it('keeps attention and all explicit-ID reads separate for identical contacts', async () => {
    await pair();
    expect(
      (await patients.getPatientsAttention(CLINIC)).items
        .map((p) => (p as { patientId?: string }).patientId)
        .sort(),
    ).toEqual(['A', 'B']);
    for (const id of ['B', 'A', 'B']) {
      await chart(id, id + '-updated');
      await patients.upsertPatientAvatar(CLINIC, EMAIL, id, id);
      expect(
        (await patients.getPatientHistory(CLINIC, EMAIL, id)).appointments.map(
          (a) => a.patientId,
        ),
      ).toEqual([id]);
      expect(
        (
          await clinical.getPatientTimeline(
            CLINIC,
            'owner-a',
            'OWNER',
            EMAIL,
            id,
          )
        ).records.map((r) => r.patientId),
      ).toEqual([id]);
      expect(await patients.getPatientAvatar(CLINIC, EMAIL, id)).toEqual({
        avatarUrl: id,
      });
    }
    expect(
      (await clinical.getOdontogram(CLINIC, 'owner-a', 'OWNER', EMAIL, 'A'))
        ?.data,
    ).toEqual({ marker: 'A-updated' });
  });
  it('never targets a stable chart through an unresolved old contact snapshot', async () => {
    await createPatient('A');
    await chart('A', 'stable');
    await h.prisma.patient.update({
      where: { id: 'A' },
      data: { email: 'changed@example.test' },
    });
    await clinical.upsertOdontogram(CLINIC, 'owner-a', 'OWNER', EMAIL, NAME, {
      marker: 'legacy',
    });
    expect(
      (
        await h.prisma.odontogramRecord.findFirstOrThrow({
          where: { patientId: 'A' },
        })
      ).data,
    ).toEqual({ marker: 'stable' });
    expect(
      (
        await h.prisma.odontogramRecord.findFirstOrThrow({
          where: { patientId: null },
        })
      ).data,
    ).toEqual({ marker: 'legacy' });
  });
  it('uses the resolved stable ID for unambiguous compatibility, including avatar batch reads', async () => {
    await createPatient('A');
    await booking('a', 'A');
    await record('r', 'A', 'a');
    await chart('A', 'stable');
    await clinical.upsertOdontogram(CLINIC, 'owner-a', 'OWNER', EMAIL, NAME, {
      marker: 'resolved',
    });
    expect(
      (
        await h.prisma.odontogramRecord.findFirstOrThrow({
          where: { patientId: 'A' },
        })
      ).data,
    ).toEqual({ marker: 'resolved' });
    expect(await h.prisma.odontogramRecord.count()).toBe(1);
    await patients.upsertPatientAvatar(CLINIC, EMAIL, 'photo');
    expect(await patients.batchGetPatientAvatars(CLINIC, [EMAIL])).toEqual({
      avatars: { [EMAIL]: 'photo' },
    });
    await createPatient('B');
    await expect(
      patients.batchGetPatientAvatars(CLINIC, [EMAIL]),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it('does not capture a quarantined standalone chart through stable identity', async () => {
    await createPatient('A');
    await h.prisma.odontogramRecord.create({
      data: {
        clinicId: CLINIC,
        patientName: NAME,
        patientEmail: EMAIL,
        data: { marker: 'legacy' },
        createdByUserId: 'owner-a',
      },
    });
    await chart('A', 'A');
    expect(
      (
        await h.prisma.odontogramRecord.findFirstOrThrow({
          where: { patientId: null },
        })
      ).data,
    ).toEqual({ marker: 'legacy' });
    expect(
      (await clinical.getOdontogram(CLINIC, 'owner-a', 'OWNER', EMAIL, 'A'))
        ?.data,
    ).toEqual({ marker: 'A' });
  });
  it('rejects conflicting ID and identifier before reading or mutating', async () => {
    await pair();
    await expect(
      clinical.getOdontogram(
        CLINIC,
        'owner-a',
        'OWNER',
        'other@example.test',
        'A',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      clinical.upsertOdontogram(
        CLINIC,
        'owner-a',
        'OWNER',
        'other@example.test',
        NAME,
        {},
        'A',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      patients.getPatientHistory(CLINIC, 'other@example.test', 'A'),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      patients.upsertPatientAvatar(CLINIC, 'other@example.test', 'wrong', 'A'),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it('resolves name-only compatibility as a name and rejects duplicates', async () => {
    await h.prisma.patient.create({
      data: { id: 'A', clinicId: CLINIC, name: NAME },
    });
    expect(await resolver.resolveLegacyIdentifier(CLINIC, NAME)).toEqual({
      id: 'A',
    });
    await h.prisma.patient.create({
      data: { id: 'B', clinicId: CLINIC, name: NAME },
    });
    await expect(
      resolver.resolveLegacyIdentifier(CLINIC, NAME),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  function bookingDto(startTime = '09:00') {
    const day = new Date();
    day.setUTCDate(day.getUTCDate() + 1);
    while ([0, 6].includes(day.getUTCDay()))
      day.setUTCDate(day.getUTCDate() + 1);
    return {
      profileId: 'profile-a',
      patientName: NAME,
      patientEmail: EMAIL,
      patientPhone: PHONE,
      appointmentDate: day.toISOString().slice(0, 10),
      startTime,
      durationMinutes: 30,
    };
  }
  it('creates separate identities for explicit new bookings with identical contacts', async () => {
    const a = await appointments.createAppointment(
      CLINIC,
      'owner-a',
      'OWNER',
      bookingDto(),
    );
    const b = await appointments.createAppointment(
      CLINIC,
      'owner-a',
      'OWNER',
      bookingDto('10:00'),
    );
    expect(a.patientId).not.toBeNull();
    expect(b.patientId).not.toBe(a.patientId);
  });
  it('serializes concurrent same-slot retries without duplicate appointments or Patients', async () => {
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        appointments.createAppointment(
          CLINIC,
          'owner-a',
          'OWNER',
          bookingDto(),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await h.prisma.appointment.count()).toBe(1);
    expect(await h.prisma.patient.count()).toBe(1);
  });
  it('quarantines a historically inconsistent foreign Patient FK', async () => {
    await createPatient('foreign', 'clinic-b');
    await booking('appt', 'foreign');
    await record('record', null, 'appt');
    expect((await backfill(true)).clinicalRecords.assigned).toBe(0);
    expect(
      (
        await h.prisma.clinicalRecord.findUniqueOrThrow({
          where: { id: 'record' },
        })
      ).patientId,
    ).toBeNull();
  });
  it('rechecks a relationship changed after the candidate scan', async () => {
    await createPatient('A');
    await createPatient('B');
    await booking('a', 'A');
    await booking('b', 'B');
    await record('r', null, 'a');
    const original = h.prisma.clinicalRecord.findMany.bind(
      h.prisma.clinicalRecord,
    );
    const scan = jest
      .spyOn(h.prisma.clinicalRecord, 'findMany')
      .mockImplementationOnce((async (args: Parameters<typeof original>[0]) => {
        const candidates = await original(args);
        await h.prisma.clinicalRecord.update({
          where: { id: 'r' },
          data: { appointmentId: 'b' },
        });
        return candidates;
      }) as never);
    try {
      expect((await backfill(true)).clinicalRecords.assigned).toBe(0);
    } finally {
      scan.mockRestore();
    }
    expect(
      (await h.prisma.clinicalRecord.findUniqueOrThrow({ where: { id: 'r' } }))
        .patientId,
    ).toBeNull();
  });

  it.each(['explicit', 'appointmentPatient', 'patientClinic'])(
    'skips changed evidence: %s',
    async (change) => {
      await createPatient('A');
      await createPatient('B');
      await booking('a', 'A');
      await record('r', null, 'a');
      const original = h.prisma.clinicalRecord.findMany.bind(
        h.prisma.clinicalRecord,
      );
      const scan = jest
        .spyOn(h.prisma.clinicalRecord, 'findMany')
        .mockImplementationOnce((async (
          args: Parameters<typeof original>[0],
        ) => {
          const candidates = await original(args);
          if (change === 'explicit')
            await h.prisma.clinicalRecord.update({
              where: { id: 'r' },
              data: { patientId: 'B' },
            });
          if (change === 'appointmentPatient')
            await h.prisma.appointment.update({
              where: { id: 'a' },
              data: { patientId: 'B' },
            });
          if (change === 'patientClinic')
            await h.prisma.patient.update({
              where: { id: 'A' },
              data: { clinicId: 'clinic-b' },
            });
          return candidates;
        }) as never);
      try {
        expect((await backfill(true)).clinicalRecords.assigned).toBe(0);
      } finally {
        scan.mockRestore();
      }
      expect(
        (
          await h.prisma.clinicalRecord.findUniqueOrThrow({
            where: { id: 'r' },
          })
        ).patientId,
      ).toBe(change === 'explicit' ? 'B' : null);
    },
  );
  it('resumes safely after a transaction fails without changing prior assignments', async () => {
    await createPatient('A');
    await booking('a', 'A');
    await record('r1', null, 'a');
    await booking('b', 'A');
    await record('r2', null, 'b');
    const original = h.prisma.$transaction.bind(h.prisma);
    let calls = 0;
    const transaction = jest
      .spyOn(h.prisma, '$transaction')
      .mockImplementation(((...args: Parameters<typeof original>) => {
        calls += 1;
        if (calls === 2)
          return Promise.reject(new Error('injected transaction failure'));
        return original(...args);
      }) as typeof h.prisma.$transaction);
    try {
      await expect(backfill(true)).rejects.toThrow(
        'injected transaction failure',
      );
    } finally {
      transaction.mockRestore();
    }
    expect(
      await h.prisma.clinicalRecord.count({ where: { patientId: 'A' } }),
    ).toBe(1);
    expect((await backfill(true)).clinicalRecords.assigned).toBe(1);
    expect((await backfill(true)).clinicalRecords.assigned).toBe(0);
    expect(
      await h.prisma.clinicalRecord.count({ where: { patientId: 'A' } }),
    ).toBe(2);
    expect(await h.prisma.patient.count()).toBe(1);
  });

  it('is idempotent, preserves explicit assignments and never assigns legacy owners', async () => {
    await createPatient('A');
    await createPatient('B');
    await booking('known', 'A');
    await booking('legacy', null);
    await record('inherit', null, 'known');
    await record('explicit', 'B');
    await h.prisma.patientAvatar.create({
      data: { clinicId: CLINIC, identifier: EMAIL },
    });
    await h.prisma.odontogramRecord.create({
      data: {
        clinicId: CLINIC,
        patientName: NAME,
        patientEmail: EMAIL,
        data: {},
        createdByUserId: 'owner-a',
      },
    });
    const before = await collect(h.prisma);
    expect((await backfill(false)).clinicalRecords.assigned).toBe(1);
    expect(await collect(h.prisma)).toEqual(before);
    expect((await backfill(true)).clinicalRecords.assigned).toBe(1);
    expect((await backfill(true)).clinicalRecords.assigned).toBe(0);
    expect((await backfill(false)).clinicalRecords.assigned).toBe(0);
    expect(await h.prisma.patient.count()).toBe(2);
    expect(
      (
        await h.prisma.appointment.findUniqueOrThrow({
          where: { id: 'legacy' },
        })
      ).patientId,
    ).toBeNull();
    expect(
      (
        await h.prisma.clinicalRecord.findUniqueOrThrow({
          where: { id: 'explicit' },
        })
      ).patientId,
    ).toBe('B');
    expect((await collect(h.prisma)).avatars.unresolved).toBe(1);
    expect((await collect(h.prisma)).odontograms.unresolved).toBe(1);
  });
});
