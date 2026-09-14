import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AppointmentStatus, UserRole } from '@prisma/client';

import { AppointmentsService } from './appointments.service';

/**
 * Whether a requested slot is inside the professional's working window.
 *
 * The concurrency suite proves two bookings cannot collide. This proves the
 * question asked before that one: may this slot exist at all? The answer runs
 * through a small hierarchy — an exception for that date overrides the weekly
 * availability, and a professional with no availability configured falls back
 * to Monday–Friday 08:00–18:00 rather than being bookable around the clock.
 *
 * The fallback is the part worth pinning. A clinic that has not set up a
 * schedule yet is the common case on day one, and "no rows" must not read as
 * "no restrictions".
 */

const CLINIC = 'clinic-1';
const USER = 'user-1';
const PROFILE = 'profile-1';

const t = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);

/** 2026-06-15 is a Monday; 2026-06-20 a Saturday. */
const MONDAY = '2026-06-15';
const SATURDAY = '2026-06-20';
const FROZEN_NOW = new Date('2026-06-01T12:00:00.000Z');

function createHarness() {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    appointment: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'appointment-1' }),
      update: jest.fn().mockResolvedValue({ id: 'appointment-1' }),
    },
    availability: { findMany: jest.fn().mockResolvedValue([]) },
    availabilityException: { findFirst: jest.fn().mockResolvedValue(null) },
    clinic: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ timezone: 'America/Sao_Paulo' }),
    },
    profile: {
      findFirst: jest.fn().mockResolvedValue({ id: PROFILE, userId: USER }),
    },
    service: { findFirst: jest.fn().mockResolvedValue(null) },
    user: { findFirst: jest.fn().mockResolvedValue({ id: 'patient-1' }) },
  };

  const prisma = {
    $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    appointment: {
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    clinic: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ timezone: 'America/Sao_Paulo' }),
    },
  };

  const service = new AppointmentsService(
    prisma as never,
    { deleteAppointmentEvent: jest.fn() } as never,
    { log: jest.fn() } as never,
  );

  return { service, prisma, tx };
}

describe('AppointmentsService — the booking window', () => {
  let h: ReturnType<typeof createHarness>;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(FROZEN_NOW);
    h = createHarness();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function book(overrides: Record<string, unknown> = {}) {
    return h.service.createAppointment(CLINIC, USER, UserRole.OWNER, {
      profileId: PROFILE,
      patientName: 'Maria Silva',
      patientPhone: '(11) 99999-9999',
      appointmentDate: MONDAY,
      startTime: '09:00',
      durationMinutes: 30,
      ...overrides,
    } as never);
  }

  // ── No availability configured ─────────────────────────────────────────────

  describe('when the professional has no availability configured', () => {
    it('accepts a weekday slot inside default business hours', async () => {
      await expect(book({ startTime: '09:00' })).resolves.toBeDefined();
    });

    it('accepts a slot ending exactly at the close of business', async () => {
      await expect(
        book({ startTime: '17:30', durationMinutes: 30 }),
      ).resolves.toBeDefined();
    });

    it('refuses a slot starting before business hours', async () => {
      await expect(book({ startTime: '07:30' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('refuses a slot running past the close of business', async () => {
      await expect(
        book({ startTime: '17:45', durationMinutes: 30 }),
      ).rejects.toThrow(ConflictException);
    });

    it('refuses a weekend slot', async () => {
      // "No rows" must not read as "no restrictions" — a clinic that has not
      // set up a schedule yet is the common case on day one.
      await expect(
        book({ appointmentDate: SATURDAY, startTime: '09:00' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ── Weekly availability ────────────────────────────────────────────────────

  describe('when weekly availability is configured', () => {
    beforeEach(() => {
      h.tx.availability.findMany.mockResolvedValue([
        { startTime: t('13:00'), endTime: t('17:00') },
      ]);
    });

    it('accepts a slot inside it', async () => {
      await expect(book({ startTime: '14:00' })).resolves.toBeDefined();
    });

    it('refuses a slot outside it, even inside default hours', async () => {
      // Configured availability replaces the default; it does not widen it.
      await expect(book({ startTime: '09:00' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('accepts a slot inside any one of several windows', async () => {
      h.tx.availability.findMany.mockResolvedValue([
        { startTime: t('08:00'), endTime: t('12:00') },
        { startTime: t('13:00'), endTime: t('17:00') },
      ]);

      await expect(book({ startTime: '08:30' })).resolves.toBeDefined();
      await expect(book({ startTime: '13:30' })).resolves.toBeDefined();
    });

    it('refuses a slot that straddles the gap between two windows', async () => {
      h.tx.availability.findMany.mockResolvedValue([
        { startTime: t('08:00'), endTime: t('12:00') },
        { startTime: t('13:00'), endTime: t('17:00') },
      ]);

      await expect(
        book({ startTime: '11:45', durationMinutes: 90 }),
      ).rejects.toThrow(ConflictException);
    });

    it('asks only for that weekday’s active windows', async () => {
      await book({ startTime: '14:00' });

      expect(h.tx.availability.findMany.mock.calls[0][0].where).toMatchObject({
        clinicId: CLINIC,
        profileId: PROFILE,
        dayOfWeek: 1, // Monday
        isActive: true,
      });
    });
  });

  // ── Exceptions ─────────────────────────────────────────────────────────────

  describe('when the date carries an exception', () => {
    it('refuses everything on a day off', async () => {
      h.tx.availabilityException.findFirst.mockResolvedValue({
        isDayOff: true,
        startTime: null,
        endTime: null,
      });
      h.tx.availability.findMany.mockResolvedValue([
        { startTime: t('08:00'), endTime: t('18:00') },
      ]);

      await expect(book({ startTime: '09:00' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('accepts a slot inside exceptional hours', async () => {
      h.tx.availabilityException.findFirst.mockResolvedValue({
        isDayOff: false,
        startTime: t('19:00'),
        endTime: t('22:00'),
      });

      // The exception overrides the weekly schedule, so an evening shift is
      // bookable even though it lies outside normal hours.
      await expect(book({ startTime: '19:30' })).resolves.toBeDefined();
    });

    it('refuses a slot outside exceptional hours', async () => {
      h.tx.availabilityException.findFirst.mockResolvedValue({
        isDayOff: false,
        startTime: t('19:00'),
        endTime: t('22:00'),
      });
      h.tx.availability.findMany.mockResolvedValue([
        { startTime: t('08:00'), endTime: t('18:00') },
      ]);

      await expect(book({ startTime: '09:00' })).rejects.toThrow(
        ConflictException,
      );
      // The weekly availability was not consulted at all.
      expect(h.tx.availability.findMany).not.toHaveBeenCalled();
    });

    it('falls through to the weekly schedule for an exception with no hours', async () => {
      h.tx.availabilityException.findFirst.mockResolvedValue({
        isDayOff: false,
        startTime: null,
        endTime: null,
      });
      h.tx.availability.findMany.mockResolvedValue([
        { startTime: t('08:00'), endTime: t('18:00') },
      ]);

      await expect(book({ startTime: '09:00' })).resolves.toBeDefined();
    });

    it('looks the exception up for that clinic, profile and date', async () => {
      await book({ startTime: '09:00' });

      const where = h.tx.availabilityException.findFirst.mock.calls[0][0]
        .where as { clinicId: string; profileId: string; exceptionDate: Date };
      expect(where.clinicId).toBe(CLINIC);
      expect(where.profileId).toBe(PROFILE);
      expect(where.exceptionDate.toISOString()).toBe(
        '2026-06-15T00:00:00.000Z',
      );
    });
  });

  // ── Time and date parsing ──────────────────────────────────────────────────

  describe('the requested time', () => {
    it.each(['9:00', '09:0', '0900', '09:00:00', 'abc'])(
      'refuses the malformed time %s',
      async (startTime) => {
        await expect(book({ startTime })).rejects.toThrow(BadRequestException);
      },
    );

    it('refuses an hour past 23', async () => {
      await expect(book({ startTime: '24:00' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('refuses a minute past 59', async () => {
      await expect(book({ startTime: '09:60' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('refuses a date in the past', async () => {
      await expect(
        book({ appointmentDate: '2020-01-01', startTime: '09:00' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── The linked patient account ─────────────────────────────────────────────

  describe('a linked patient account', () => {
    it('is verified before the appointment is written', async () => {
      await book({ patientUserId: 'patient-1' });

      expect(h.tx.user.findFirst).toHaveBeenCalled();
    });

    it('is not looked up when the booking names no account', async () => {
      await book();

      expect(h.tx.user.findFirst).not.toHaveBeenCalled();
    });

    it('stops the booking when the account does not exist', async () => {
      h.tx.user.findFirst.mockResolvedValue(null);

      await expect(book({ patientUserId: 'ghost' })).rejects.toThrow(
        NotFoundException,
      );
      expect(h.tx.appointment.create).not.toHaveBeenCalled();
    });
  });

  // ── Cancelling ─────────────────────────────────────────────────────────────

  describe('cancelling', () => {
    function existing(status: AppointmentStatus) {
      h.prisma.appointment.findFirst.mockResolvedValue({
        id: 'appointment-1',
        clinicId: CLINIC,
        status,
        profile: { userId: USER },
      });
      h.prisma.appointment.update.mockResolvedValue({ id: 'appointment-1' });
      h.prisma.appointment.updateMany.mockResolvedValue({ count: 1 });
    }

    it.each([AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED])(
      'allows cancelling a %s appointment',
      async (status) => {
        existing(status);

        await expect(
          h.service.cancelAppointment(
            CLINIC,
            USER,
            UserRole.OWNER,
            'appointment-1',
            {} as never,
          ),
        ).resolves.toBeDefined();
      },
    );

    it.each([AppointmentStatus.COMPLETED, AppointmentStatus.CANCELED])(
      'refuses to cancel a %s appointment',
      async (status) => {
        existing(status);

        // Cancelling a completed appointment would unwind treatment that
        // already happened, including whatever was billed for it. Matched on
        // the message as well as the type: the status machine downstream
        // refuses the same transition, so a type-only assertion would still
        // pass with this guard removed.
        await expect(
          h.service.cancelAppointment(
            CLINIC,
            USER,
            UserRole.OWNER,
            'appointment-1',
            {} as never,
          ),
        ).rejects.toThrow(
          new UnprocessableEntityException(
            'Este agendamento não pode ser cancelado no status atual.',
          ),
        );
      },
    );

    it('records the clinic as the canceller by default', async () => {
      existing(AppointmentStatus.PENDING);

      await h.service.cancelAppointment(
        CLINIC,
        USER,
        UserRole.OWNER,
        'appointment-1',
        undefined as never,
      );

      expect(h.prisma.appointment.update.mock.calls[0][0].data).toMatchObject({
        status: 'CANCELED',
        canceledBy: 'CLINIC',
      });
    });

    it('records the patient when they cancelled, with their reason', async () => {
      existing(AppointmentStatus.CONFIRMED);

      await h.service.cancelAppointment(
        CLINIC,
        USER,
        UserRole.OWNER,
        'appointment-1',
        { canceledBy: 'PATIENT', cancellationReason: 'Imprevisto' } as never,
      );

      expect(h.prisma.appointment.update.mock.calls[0][0].data).toMatchObject({
        canceledBy: 'PATIENT',
        cancellationReason: 'Imprevisto',
      });
    });

    it('reports an appointment from another clinic as not found', async () => {
      h.prisma.appointment.findFirst.mockResolvedValue(null);

      await expect(
        h.service.cancelAppointment(
          CLINIC,
          USER,
          UserRole.OWNER,
          'foreign',
          {} as never,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
