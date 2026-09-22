import { createPatientResolverMock } from '../../../test/support/patient-resolver.mock';
import {
  AppointmentPaymentStatus,
  AppointmentStatus,
  NotificationChannel,
} from '@prisma/client';

import { PatientsService } from './patients.service';

/**
 * Patient records, which the clinic derives from appointments rather than
 * storing directly — a patient is identified by email when there is one and by
 * name otherwise. That identity rule is what every method here depends on, and
 * getting it wrong merges two people or splits one.
 *
 * `getPatientsAttention` is the follow-up worklist. Each reason has a
 * different commercial meaning (unpaid work, a lapsed patient, a cancellation
 * to chase), so the classification, its priority ordering and the summary
 * counters are pinned case by case.
 */

const CLINIC = 'clinic-1';
const TODAY = new Date('2026-06-15T12:00:00.000Z');

/** appointmentDate is stored at UTC midnight. */
function day(offsetDays: number): Date {
  return new Date(Date.UTC(2026, 5, 15 + offsetDays));
}

function createPrisma() {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    appointment: { findMany: jest.fn().mockResolvedValue([]) },
    patientAvatar: {
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
    },
    notificationConsent: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

function appt(overrides: Record<string, unknown> = {}) {
  return {
    patientName: 'Maria Silva',
    patientEmail: 'maria@example.test',
    patientPhone: null,
    appointmentDate: day(-10),
    status: AppointmentStatus.COMPLETED,
    paymentStatus: AppointmentPaymentStatus.PAID,
    estimatedAmountCents: 10000,
    paidAmountCents: 10000,
    profile: { displayName: 'Dra. Ana' },
    ...overrides,
  };
}

describe('PatientsService', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let service: PatientsService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(TODAY);
    prisma = createPrisma();
    service = new PatientsService(
      prisma as never,
      createPatientResolverMock() as never,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── listPatients ───────────────────────────────────────────────────────────

  describe('listPatients', () => {
    it('converts the aggregate bigint counters to numbers', async () => {
      prisma.$queryRaw.mockResolvedValue([
        {
          identifier: 'maria@example.test',
          patientName: 'Maria',
          patientEmail: 'maria@example.test',
          patientPhone: '11999998888',
          totalAppointments: 5n,
          completedAppointments: 3n,
          canceledAppointments: 1n,
          lastVisit: new Date('2026-06-01T00:00:00.000Z'),
          avatarUrl: 'data:image/png;base64,x',
        },
      ]);

      const result = await service.listPatients(CLINIC);

      expect(result.data[0]).toEqual({
        patientId: null,
        identifier: 'maria@example.test',
        patientName: 'Maria',
        patientEmail: 'maria@example.test',
        patientPhone: '11999998888',
        totalAppointments: 5,
        completedAppointments: 3,
        canceledAppointments: 1,
        lastVisit: '2026-06-01',
        avatarUrl: 'data:image/png;base64,x',
      });
      expect(result.total).toBe(1);
    });

    it('reports a null last visit rather than an invalid date', async () => {
      prisma.$queryRaw.mockResolvedValue([
        {
          identifier: 'x',
          patientName: 'X',
          patientEmail: null,
          patientPhone: null,
          totalAppointments: 0n,
          completedAppointments: 0n,
          canceledAppointments: 0n,
          lastVisit: null,
          avatarUrl: null,
        },
      ]);

      expect((await service.listPatients(CLINIC)).data[0].lastVisit).toBeNull();
    });

    it('returns an empty list for a clinic with no appointments', async () => {
      await expect(service.listPatients(CLINIC)).resolves.toEqual({
        data: [],
        total: 0,
      });
    });

    it('scopes the query to the clinic', async () => {
      await service.listPatients(CLINIC);

      const sql = JSON.stringify(prisma.$queryRaw.mock.calls[0][0]);
      expect(sql).toContain(CLINIC);
    });

    it('adds a search filter only when a term is given', async () => {
      await service.listPatients(CLINIC);
      const withoutSearch = JSON.stringify(prisma.$queryRaw.mock.calls[0][0]);
      expect(withoutSearch).not.toContain('ILIKE');

      await service.listPatients(CLINIC, 'maria');
      const withSearch = JSON.stringify(prisma.$queryRaw.mock.calls[1][0]);
      expect(withSearch).toContain('ILIKE');
      expect(withSearch).toContain('%maria%');
    });

    it('ignores a whitespace-only search term', async () => {
      await service.listPatients(CLINIC, '   ');
      expect(JSON.stringify(prisma.$queryRaw.mock.calls[0][0])).not.toContain(
        'ILIKE',
      );
    });

    it('trims the search term before matching', async () => {
      await service.listPatients(CLINIC, '  maria  ');
      expect(JSON.stringify(prisma.$queryRaw.mock.calls[0][0])).toContain(
        '%maria%',
      );
    });
  });

  // ── Avatars ────────────────────────────────────────────────────────────────

  describe('avatars', () => {
    it('reports a null avatar for a patient who has none', async () => {
      await expect(
        service.getPatientAvatar(CLINIC, 'maria@example.test'),
      ).resolves.toEqual({ avatarUrl: null });
    });

    it('keys the avatar on clinic and identifier together', async () => {
      await service.getPatientAvatar(CLINIC, 'maria@example.test');

      // Without a patientId the lookup stays on the legacy identifier, and is
      // restricted to rows that have not been given an identity yet.
      expect(prisma.patientAvatar.findFirst.mock.calls[0][0].where).toEqual({
        clinicId: CLINIC,
        patientId: null,
        identifier: { equals: 'maria@example.test', mode: 'insensitive' },
      });
    });

    it('finds an avatar stored under a different email casing', async () => {
      // Rows written before identity normalization hold the address exactly as
      // it was typed, so an exact match would lose the patient's photo.
      await service.getPatientAvatar(CLINIC, 'maria@example.test');

      expect(
        prisma.patientAvatar.findFirst.mock.calls[0][0].where.identifier.mode,
      ).toBe('insensitive');
    });

    it('stores a null avatar when clearing one', async () => {
      await service.upsertPatientAvatar(
        CLINIC,
        'maria@example.test',
        undefined,
      );

      expect(
        prisma.patientAvatar.create.mock.calls[0][0].data.avatarUrl,
      ).toBeNull();
    });

    it('updates the existing row rather than adding one per email casing', async () => {
      prisma.patientAvatar.findFirst.mockResolvedValue({ id: 'avatar-1' });

      await service.upsertPatientAvatar(CLINIC, 'Maria@Example.test', 'data:1');

      expect(prisma.patientAvatar.update).toHaveBeenCalledWith({
        where: { id: 'avatar-1' },
        data: { avatarUrl: 'data:1' },
      });
      expect(prisma.patientAvatar.create).not.toHaveBeenCalled();
    });

    it('returns an entry for every requested identifier, null where absent', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { identifier: 'a@x.test', avatarUrl: 'data:1' },
      ]);

      await expect(
        service.batchGetPatientAvatars(CLINIC, ['a@x.test', 'b@x.test']),
      ).resolves.toEqual({
        avatars: { 'a@x.test': 'data:1', 'b@x.test': null },
      });
    });

    it('deduplicates and trims identifiers before querying', async () => {
      await service.batchGetPatientAvatars(CLINIC, [
        ' a@x.test ',
        'a@x.test',
        'b@x.test',
      ]);

      // One raw query, carrying each distinct identifier exactly once.
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('skips the query entirely when every identifier is blank', async () => {
      await expect(
        service.batchGetPatientAvatars(CLINIC, ['', '  ']),
      ).resolves.toEqual({
        avatars: {},
      });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  // ── Patient identity ───────────────────────────────────────────────────────

  describe('getPatientHistory', () => {
    it('matches on email when the identifier looks like one', async () => {
      await service.getPatientHistory(CLINIC, 'maria@example.test');

      expect(prisma.appointment.findMany.mock.calls[0][0].where).toEqual({
        clinicId: CLINIC,
        patientId: null,
        patientEmail: { equals: 'maria@example.test', mode: 'insensitive' },
      });
    });

    it('finds the whole history when the email casing varied across visits', async () => {
      // Regression: an exact match returned only the appointments whose email
      // happened to be spelled the way the caller typed it, silently hiding
      // the rest of the patient's history.
      await service.getPatientHistory(CLINIC, ' Maria@Example.TEST ');

      expect(prisma.appointment.findMany.mock.calls[0][0].where).toEqual({
        clinicId: CLINIC,
        patientId: null,
        patientEmail: { equals: 'maria@example.test', mode: 'insensitive' },
      });
    });

    it('matches on name, and only where no email exists, otherwise', async () => {
      // Without the `patientEmail: null` guard, a walk-in named "Maria Silva"
      // would pull in the history of every Maria Silva who has an email.
      await service.getPatientHistory(CLINIC, 'Maria Silva');

      expect(prisma.appointment.findMany.mock.calls[0][0].where).toEqual({
        clinicId: CLINIC,
        patientId: null,
        patientName: { equals: 'Maria Silva', mode: 'insensitive' },
        patientEmail: null,
      });
    });

    it('treats a malformed address as a name', async () => {
      await service.getPatientHistory(CLINIC, 'maria@');

      expect(prisma.appointment.findMany.mock.calls[0][0].where).toMatchObject({
        patientName: { equals: 'maria@', mode: 'insensitive' },
      });
    });

    it('orders newest appointment first', async () => {
      await service.getPatientHistory(CLINIC, 'maria@example.test');

      expect(prisma.appointment.findMany.mock.calls[0][0].orderBy).toEqual([
        { appointmentDate: 'desc' },
        { startTime: 'desc' },
      ]);
    });
  });

  // ── Attention worklist ─────────────────────────────────────────────────────

  describe('getPatientsAttention', () => {
    async function attention(appointments: unknown[]) {
      prisma.appointment.findMany.mockResolvedValue(appointments);
      return service.getPatientsAttention(CLINIC);
    }

    it('lists nobody for a clinic with no appointments', async () => {
      const result = await attention([]);
      expect(result.items).toEqual([]);
      expect(result.summary.total).toBe(0);
    });

    it('ignores a patient in good standing', async () => {
      const result = await attention([
        appt({ appointmentDate: day(-5) }),
        appt({ appointmentDate: day(5), status: AppointmentStatus.CONFIRMED }),
      ]);

      expect(result.items).toEqual([]);
    });

    it('ignores a patient whose only appointments were cancelled', async () => {
      const result = await attention([
        appt({ status: AppointmentStatus.CANCELED, appointmentDate: day(-5) }),
      ]);

      expect(result.items).toEqual([]);
    });

    it('flags unpaid completed work as HIGH priority', async () => {
      const result = await attention([
        appt({
          paymentStatus: AppointmentPaymentStatus.PAYMENT_PENDING,
          estimatedAmountCents: 20000,
          paidAmountCents: 0,
          appointmentDate: day(5),
        }),
        appt({ appointmentDate: day(10), status: AppointmentStatus.CONFIRMED }),
      ]);

      expect(result.items[0].reason).toBe('PENDING_PAYMENT');
      expect(result.items[0].priority).toBe('HIGH');
      expect(result.items[0].pendingAmountCents).toBe(20000);
    });

    it('counts only the outstanding balance on a part-paid appointment', async () => {
      const result = await attention([
        appt({
          paymentStatus: AppointmentPaymentStatus.PARTIALLY_PAID,
          estimatedAmountCents: 20000,
          paidAmountCents: 15000,
          appointmentDate: day(5),
        }),
        appt({ appointmentDate: day(10), status: AppointmentStatus.CONFIRMED }),
      ]);

      expect(result.items[0].pendingAmountCents).toBe(5000);
    });

    it('never reports a negative balance when someone overpaid', async () => {
      const result = await attention([
        appt({
          paymentStatus: AppointmentPaymentStatus.PARTIALLY_PAID,
          estimatedAmountCents: 10000,
          paidAmountCents: 15000,
          appointmentDate: day(5),
        }),
        appt({ appointmentDate: day(10), status: AppointmentStatus.CONFIRMED }),
      ]);

      expect(result.items[0].pendingAmountCents).toBe(0);
    });

    it('flags a patient last seen over ninety days ago as INACTIVE', async () => {
      const result = await attention([appt({ appointmentDate: day(-120) })]);

      expect(result.items[0].allReasons).toContain('INACTIVE');
      expect(result.items[0].priority).toBe('HIGH');
    });

    it('flags a recent patient with nothing booked as NO_UPCOMING_APPOINTMENT', async () => {
      const result = await attention([appt({ appointmentDate: day(-10) })]);

      expect(result.items[0].allReasons).toContain('NO_UPCOMING_APPOINTMENT');
      expect(result.items[0].priority).toBe('LOW');
    });

    it('does not flag a lapsed patient who already has a future booking', async () => {
      const result = await attention([
        appt({ appointmentDate: day(-120) }),
        appt({ appointmentDate: day(7), status: AppointmentStatus.CONFIRMED }),
      ]);

      expect(result.items).toEqual([]);
    });

    it('flags a recent cancellation as MEDIUM priority', async () => {
      const result = await attention([
        appt({ appointmentDate: day(-5), status: AppointmentStatus.CANCELED }),
        appt({
          appointmentDate: day(-10),
          status: AppointmentStatus.CONFIRMED,
        }),
      ]);

      expect(result.items[0].allReasons).toContain('RECENTLY_CANCELED');
      expect(result.items[0].priority).toBe('MEDIUM');
    });

    it('flags a recent no-show', async () => {
      const result = await attention([
        appt({ appointmentDate: day(-5), status: AppointmentStatus.NO_SHOW }),
      ]);

      expect(result.items[0].allReasons).toContain('RECENT_NO_SHOW');
    });

    it('ignores a cancellation older than thirty days', async () => {
      const result = await attention([
        appt({ appointmentDate: day(-60), status: AppointmentStatus.CANCELED }),
        appt({ appointmentDate: day(-5), status: AppointmentStatus.CONFIRMED }),
      ]);

      expect(result.items.flatMap((i) => i.allReasons)).not.toContain(
        'RECENTLY_CANCELED',
      );
    });

    it('reports the highest-priority reason first', async () => {
      const result = await attention([
        appt({
          appointmentDate: day(-120),
          paymentStatus: AppointmentPaymentStatus.PAYMENT_PENDING,
          paidAmountCents: 0,
        }),
      ]);

      expect(result.items[0].reason).toBe('PENDING_PAYMENT');
      expect(result.items[0].allReasons).toEqual([
        'PENDING_PAYMENT',
        'INACTIVE',
      ]);
    });

    it('groups a patient by email regardless of case or spacing', async () => {
      const result = await attention([
        appt({
          patientEmail: 'Maria@Example.test',
          appointmentDate: day(-120),
        }),
        appt({
          patientEmail: ' maria@example.test ',
          appointmentDate: day(-110),
        }),
      ]);

      expect(result.items).toHaveLength(1);
    });

    it('keeps two patients with the same name but different emails apart', async () => {
      const result = await attention([
        appt({ patientEmail: 'a@x.test', appointmentDate: day(-120) }),
        appt({ patientEmail: 'b@x.test', appointmentDate: day(-120) }),
      ]);

      expect(result.items).toHaveLength(2);
    });

    it('groups an email-less patient by name', async () => {
      const result = await attention([
        appt({ patientEmail: null, appointmentDate: day(-120) }),
        appt({ patientEmail: null, appointmentDate: day(-110) }),
      ]);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].identifier).toBe('Maria Silva');
    });

    it('picks up a phone number from whichever appointment recorded one', async () => {
      const result = await attention([
        appt({ patientPhone: null, appointmentDate: day(-120) }),
        appt({ patientPhone: '11999998888', appointmentDate: day(-110) }),
      ]);

      expect(result.items[0].patientPhone).toBe('11999998888');
    });

    it('reports the last past and next future appointment dates', async () => {
      const result = await attention([
        appt({ appointmentDate: day(-120) }),
        appt({
          appointmentDate: day(-100),
          paymentStatus: AppointmentPaymentStatus.PAYMENT_PENDING,
          paidAmountCents: 0,
        }),
        appt({ appointmentDate: day(20), status: AppointmentStatus.CONFIRMED }),
      ]);

      expect(result.items[0].lastAppointmentAt).toBe(
        day(-100).toISOString().slice(0, 10),
      );
      expect(result.items[0].nextAppointmentAt).toBe(
        day(20).toISOString().slice(0, 10),
      );
    });

    it('names the professional from the most recent past appointment', async () => {
      const result = await attention([
        appt({
          appointmentDate: day(-120),
          profile: { displayName: 'Dr. Antigo' },
        }),
        appt({
          appointmentDate: day(-100),
          profile: { displayName: 'Dra. Recente' },
        }),
      ]);

      expect(result.items[0].lastProfessionalName).toBe('Dra. Recente');
    });

    it('sorts HIGH before MEDIUM before LOW', async () => {
      const result = await attention([
        appt({ patientEmail: 'low@x.test', appointmentDate: day(-10) }),
        appt({ patientEmail: 'high@x.test', appointmentDate: day(-120) }),
        appt({
          patientEmail: 'medium@x.test',
          appointmentDate: day(-5),
          status: AppointmentStatus.NO_SHOW,
        }),
      ]);

      expect(result.items.map((i) => i.priority)).toEqual([
        'HIGH',
        'MEDIUM',
        'LOW',
      ]);
    });

    it('resolves WhatsApp consent by digits-only phone', async () => {
      prisma.notificationConsent.findMany.mockResolvedValue([
        { phone: '11999998888' },
      ]);

      const result = await attention([
        appt({ patientPhone: '(11) 99999-8888', appointmentDate: day(-120) }),
      ]);

      expect(
        prisma.notificationConsent.findMany.mock.calls[0][0].where,
      ).toMatchObject({
        clinicId: CLINIC,
        phone: { in: ['11999998888'] },
        channel: NotificationChannel.WHATSAPP,
        granted: true,
      });
      expect(result.items[0].hasWhatsappConsent).toBe(true);
    });

    it('reports no consent when none is on file', async () => {
      const result = await attention([
        appt({ patientPhone: '11999998888', appointmentDate: day(-120) }),
      ]);

      expect(result.items[0].hasWhatsappConsent).toBe(false);
    });

    it('skips the consent query when nobody has a phone number', async () => {
      await attention([
        appt({ patientPhone: null, appointmentDate: day(-120) }),
      ]);
      expect(prisma.notificationConsent.findMany).not.toHaveBeenCalled();
    });

    it('counts each reason in the summary', async () => {
      prisma.notificationConsent.findMany.mockResolvedValue([
        { phone: '11999998888' },
      ]);

      const result = await attention([
        appt({ patientEmail: 'inactive@x.test', appointmentDate: day(-120) }),
        appt({ patientEmail: 'recent@x.test', appointmentDate: day(-10) }),
        appt({
          patientEmail: 'owing@x.test',
          appointmentDate: day(-5),
          paymentStatus: AppointmentPaymentStatus.PAYMENT_PENDING,
          paidAmountCents: 0,
          patientPhone: '11999998888',
        }),
        appt({
          patientEmail: 'noshow@x.test',
          appointmentDate: day(-3),
          status: AppointmentStatus.NO_SHOW,
        }),
      ]);

      expect(result.summary).toEqual({
        total: 4,
        inactive: 1,
        // All four are flagged partly because nothing is booked ahead — the
        // no-show patient included, since their only appointment is past.
        withoutUpcomingAppointment: 4,
        pendingPayment: 1,
        recentlyCanceled: 0,
        recentNoShow: 1,
        withWhatsappConsent: 1,
      });
    });

    it('scopes every query to the clinic', async () => {
      prisma.notificationConsent.findMany.mockResolvedValue([]);
      await attention([
        appt({ patientPhone: '11999998888', appointmentDate: day(-120) }),
      ]);

      expect(prisma.appointment.findMany.mock.calls[0][0].where).toEqual({
        clinicId: CLINIC,
      });
      expect(
        prisma.notificationConsent.findMany.mock.calls[0][0].where.clinicId,
      ).toBe(CLINIC);
    });
  });
});
