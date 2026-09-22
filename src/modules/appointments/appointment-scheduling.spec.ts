import { createPatientResolverMock } from '../../../test/support/patient-resolver.mock';
import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AppointmentStatus, UserRole } from '@prisma/client';

import { AppointmentsService } from './appointments.service';

/**
 * Scheduling rules: the status machine and slot availability.
 *
 * `appointments.service.spec.ts` covers booking concurrency and the payment
 * guards. This suite covers the two rule sets around them.
 *
 * The status machine is the clinic's audit trail. Once an appointment is
 * COMPLETED, NO_SHOW or CANCELED it is terminal — reopening one would let a
 * completed, invoiced appointment be silently rewritten. Every transition,
 * legal and illegal, is enumerated rather than sampled.
 *
 * Slot availability is what the booking screen offers. The fallback ladder —
 * a day-off exception, then a custom exception window, then configured
 * availability, then default business hours — is the part that quietly breaks:
 * each rung must shadow the one below it.
 */

const CLINIC = 'clinic-1';
const PROFILE = 'profile-1';
const USER = 'user-1';

/** 2026-06-15 is a Monday; 2026-06-20 a Saturday. */
const MONDAY = '2026-06-15';
const SATURDAY = '2026-06-20';

function time(value: string): Date {
  return new Date(`1970-01-01T${value}:00.000Z`);
}

function createPrisma() {
  return {
    appointment: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    availability: { findMany: jest.fn().mockResolvedValue([]) },
    availabilityException: { findFirst: jest.fn().mockResolvedValue(null) },
    profile: {
      findFirst: jest.fn().mockResolvedValue({ id: PROFILE, userId: USER }),
    },
    service: { findFirst: jest.fn().mockResolvedValue(null) },
    clinic: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ timezone: 'America/Sao_Paulo' }),
    },
    $transaction: jest.fn(),
  };
}

describe('AppointmentsService — scheduling rules', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let service: AppointmentsService;

  beforeEach(() => {
    prisma = createPrisma();
    service = new AppointmentsService(
      prisma as never,
      {
        deleteAppointmentEvent: jest.fn().mockResolvedValue(undefined),
      } as never,
      { log: jest.fn().mockResolvedValue(undefined) } as never,
      createPatientResolverMock() as never,
    );
  });

  // ── Status machine ─────────────────────────────────────────────────────────

  describe('status transitions', () => {
    /** Puts an appointment in `from`, then attempts `to`. */
    function attempt(from: AppointmentStatus, to: AppointmentStatus) {
      prisma.appointment.findFirst.mockResolvedValue({
        id: 'a1',
        status: from,
        // Well in the past, so the "has it happened yet" guard never fires.
        appointmentDate: new Date('2020-01-01T00:00:00.000Z'),
        startTime: time('09:00'),
        profile: { userId: USER },
      });

      return service.updateAppointmentStatus(
        CLINIC,
        USER,
        UserRole.OWNER,
        'a1',
        {
          status: to,
        } as never,
      );
    }

    const ALLOWED: Array<[AppointmentStatus, AppointmentStatus]> = [
      ['PENDING', 'CONFIRMED'],
      ['PENDING', 'CANCELED'],
      ['CONFIRMED', 'COMPLETED'],
      ['CONFIRMED', 'NO_SHOW'],
      ['CONFIRMED', 'CANCELED'],
    ];

    it.each(ALLOWED)('allows %s → %s', async (from, to) => {
      await expect(attempt(from, to)).resolves.toBeDefined();
      expect(prisma.appointment.update).toHaveBeenCalled();
    });

    const ALL: AppointmentStatus[] = [
      'PENDING',
      'CONFIRMED',
      'COMPLETED',
      'NO_SHOW',
      'CANCELED',
    ];

    const FORBIDDEN = ALL.flatMap((from) =>
      ALL.filter(
        (to) =>
          from !== to && !ALLOWED.some(([f, t]) => f === from && t === to),
      ).map((to) => [from, to] as [AppointmentStatus, AppointmentStatus]),
    );

    it.each(FORBIDDEN)(
      'refuses %s → %s and writes nothing',
      async (from, to) => {
        await expect(attempt(from, to)).rejects.toThrow(
          UnprocessableEntityException,
        );
        expect(prisma.appointment.update).not.toHaveBeenCalled();
      },
    );

    it('covers every status pair exactly once between the allowed and forbidden sets', () => {
      // Guards the matrix above from silently losing a case.
      const sameStatus = ALL.length;
      expect(ALLOWED.length + FORBIDDEN.length).toBe(
        ALL.length * ALL.length - sameStatus,
      );
    });

    it('explains that an unconfirmed appointment cannot be marked as a no-show', async () => {
      await expect(attempt('PENDING', 'NO_SHOW')).rejects.toThrow(
        /ainda não foi confirmado/,
      );
    });

    it('explains that an unconfirmed appointment cannot be completed', async () => {
      await expect(attempt('PENDING', 'COMPLETED')).rejects.toThrow(
        /Não é possível concluir/,
      );
    });

    it.each([
      ['COMPLETED' as AppointmentStatus, /já foi concluído/],
      ['NO_SHOW' as AppointmentStatus, /já foi marcado como não compareceu/],
      ['CANCELED' as AppointmentStatus, /já foi cancelado/],
    ])('explains that a %s appointment is terminal', async (from, message) => {
      await expect(attempt(from, 'CONFIRMED')).rejects.toThrow(message);
    });

    it('reports an unknown appointment as not found', async () => {
      prisma.appointment.findFirst.mockResolvedValue(null);

      await expect(
        service.updateAppointmentStatus(CLINIC, USER, UserRole.OWNER, 'ghost', {
          status: 'CONFIRMED',
        } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it('scopes the lookup to the caller’s clinic', async () => {
      await attempt('PENDING', 'CONFIRMED');

      expect(prisma.appointment.findFirst.mock.calls[0][0].where).toMatchObject(
        {
          id: 'a1',
          clinicId: CLINIC,
        },
      );
    });
  });

  // ── "Has it happened yet" guard ────────────────────────────────────────────

  describe('completing or no-showing a future appointment', () => {
    function futureAppointment() {
      prisma.appointment.findFirst.mockResolvedValue({
        id: 'a1',
        status: 'CONFIRMED',
        appointmentDate: new Date('2099-01-01T00:00:00.000Z'),
        startTime: time('09:00'),
        profile: { userId: USER },
      });
    }

    it('refuses to complete an appointment that has not happened yet', async () => {
      futureAppointment();

      await expect(
        service.updateAppointmentStatus(CLINIC, USER, UserRole.OWNER, 'a1', {
          status: 'COMPLETED',
        } as never),
      ).rejects.toThrow(/ainda não ocorreu/);
    });

    it('refuses to record a no-show for a future appointment', async () => {
      futureAppointment();

      await expect(
        service.updateAppointmentStatus(CLINIC, USER, UserRole.OWNER, 'a1', {
          status: 'NO_SHOW',
        } as never),
      ).rejects.toThrow(/agendamento futuro/);
    });

    it('still allows cancelling a future appointment', async () => {
      futureAppointment();

      await expect(
        service.updateAppointmentStatus(CLINIC, USER, UserRole.OWNER, 'a1', {
          status: 'CANCELED',
        } as never),
      ).resolves.toBeDefined();
    });

    it('judges "future" in the clinic’s own timezone', async () => {
      futureAppointment();
      await service
        .updateAppointmentStatus(CLINIC, USER, UserRole.OWNER, 'a1', {
          status: 'COMPLETED',
        } as never)
        .catch(() => undefined);

      expect(prisma.clinic.findUnique.mock.calls[0][0]).toMatchObject({
        where: { id: CLINIC },
        select: { timezone: true },
      });
    });

    it('falls back to Brazil time when the clinic has no timezone set', async () => {
      prisma.clinic.findUnique.mockResolvedValue({ timezone: null });
      futureAppointment();

      await expect(
        service.updateAppointmentStatus(CLINIC, USER, UserRole.OWNER, 'a1', {
          status: 'COMPLETED',
        } as never),
      ).rejects.toThrow(/ainda não ocorreu/);
    });
  });

  // ── Dentist scope ──────────────────────────────────────────────────────────

  describe('dentist access', () => {
    function appointmentOwnedBy(
      userId: string,
      status: AppointmentStatus = 'CONFIRMED',
    ) {
      prisma.appointment.findFirst.mockResolvedValue({
        id: 'a1',
        status,
        appointmentDate: new Date('2020-01-01T00:00:00.000Z'),
        startTime: time('09:00'),
        profile: { userId },
      });
    }

    it.each(['COMPLETED', 'NO_SHOW'] as AppointmentStatus[])(
      'lets a dentist record %s on their own appointment',
      async (status) => {
        appointmentOwnedBy('dentist-1');

        await expect(
          service.updateAppointmentStatus(
            CLINIC,
            'dentist-1',
            UserRole.DENTIST,
            'a1',
            {
              status,
            } as never,
          ),
        ).resolves.toBeDefined();
      },
    );

    it.each(['CONFIRMED', 'CANCELED'] as AppointmentStatus[])(
      'refuses a dentist setting %s — confirming and cancelling belong to reception',
      async (status) => {
        appointmentOwnedBy('dentist-1', 'PENDING');

        await expect(
          service.updateAppointmentStatus(
            CLINIC,
            'dentist-1',
            UserRole.DENTIST,
            'a1',
            {
              status,
            } as never,
          ),
        ).rejects.toThrow(/só podem marcar consultas como concluídas/);
        expect(prisma.appointment.update).not.toHaveBeenCalled();
      },
    );

    it('refuses a dentist acting on another professional’s appointment', async () => {
      appointmentOwnedBy('other-dentist');

      await expect(
        service.updateAppointmentStatus(
          CLINIC,
          'dentist-1',
          UserRole.DENTIST,
          'a1',
          {
            status: 'COMPLETED',
          } as never,
        ),
      ).rejects.toThrow('Profissionais podem acessar apenas a própria agenda');
      expect(prisma.appointment.update).not.toHaveBeenCalled();
    });

    it('places no such restriction on an OWNER', async () => {
      appointmentOwnedBy('other-dentist', 'PENDING');

      await expect(
        service.updateAppointmentStatus(CLINIC, USER, UserRole.OWNER, 'a1', {
          status: 'CONFIRMED',
        } as never),
      ).resolves.toBeDefined();
    });
  });

  // ── Available slots ────────────────────────────────────────────────────────

  describe('getAvailableSlots', () => {
    const slotsFor = (overrides: Record<string, unknown> = {}) =>
      service.getAvailableSlots(CLINIC, {
        profileId: PROFILE,
        date: MONDAY,
        ...overrides,
      } as never);

    it('refuses a profile from another clinic', async () => {
      prisma.profile.findFirst.mockResolvedValue(null);
      await expect(slotsFor()).rejects.toThrow(NotFoundException);
    });

    it('scopes the profile check to the caller’s clinic', async () => {
      await slotsFor();
      expect(prisma.profile.findFirst.mock.calls[0][0].where).toMatchObject({
        id: PROFILE,
        clinicId: CLINIC,
      });
    });

    it('offers the default business day when nothing is configured', async () => {
      const slots = await slotsFor();

      // 08:00–18:00 in 30-minute steps, with a 30-minute default duration.
      expect(slots[0].time).toBe('08:00');
      expect(slots.at(-1)?.time).toBe('17:30');
      expect(slots).toHaveLength(20);
      expect(slots.every((slot) => slot.available)).toBe(true);
    });

    it('offers nothing on a weekend by default', async () => {
      await expect(slotsFor({ date: SATURDAY })).resolves.toEqual([]);
    });

    it('offers nothing when the day is marked off', async () => {
      prisma.availabilityException.findFirst.mockResolvedValue({
        isDayOff: true,
      });
      await expect(slotsFor()).resolves.toEqual([]);
    });

    it('lets a day-off exception override configured availability', async () => {
      prisma.availabilityException.findFirst.mockResolvedValue({
        isDayOff: true,
      });
      prisma.availability.findMany.mockResolvedValue([
        { startTime: time('08:00'), endTime: time('12:00') },
      ]);

      await expect(slotsFor()).resolves.toEqual([]);
      expect(prisma.availability.findMany).not.toHaveBeenCalled();
    });

    it('uses an exception window in place of the configured hours', async () => {
      prisma.availabilityException.findFirst.mockResolvedValue({
        isDayOff: false,
        startTime: time('14:00'),
        endTime: time('16:00'),
      });
      prisma.availability.findMany.mockResolvedValue([
        { startTime: time('08:00'), endTime: time('18:00') },
      ]);

      const slots = await slotsFor();

      expect(slots.map((s) => s.time)).toEqual([
        '14:00',
        '14:30',
        '15:00',
        '15:30',
      ]);
    });

    it('uses configured availability in place of the default hours', async () => {
      prisma.availability.findMany.mockResolvedValue([
        { startTime: time('09:00'), endTime: time('11:00') },
      ]);

      const slots = await slotsFor();
      expect(slots.map((s) => s.time)).toEqual([
        '09:00',
        '09:30',
        '10:00',
        '10:30',
      ]);
    });

    it('offers slots across several configured windows', async () => {
      prisma.availability.findMany.mockResolvedValue([
        { startTime: time('09:00'), endTime: time('10:00') },
        { startTime: time('14:00'), endTime: time('15:00') },
      ]);

      const slots = await slotsFor();
      expect(slots.map((s) => s.time)).toEqual([
        '09:00',
        '09:30',
        '14:00',
        '14:30',
      ]);
    });

    it('asks only for the weekday being booked, and only active windows', async () => {
      await slotsFor();

      expect(prisma.availability.findMany.mock.calls[0][0].where).toMatchObject(
        {
          clinicId: CLINIC,
          profileId: PROFILE,
          dayOfWeek: 1,
          isActive: true,
        },
      );
    });

    it('marks an occupied slot as unavailable, with a reason', async () => {
      prisma.availability.findMany.mockResolvedValue([
        { startTime: time('09:00'), endTime: time('11:00') },
      ]);
      prisma.appointment.findMany.mockResolvedValue([
        { startTime: time('09:30'), endTime: time('10:00') },
      ]);

      const slots = await slotsFor();

      expect(slots.find((s) => s.time === '09:30')).toEqual({
        time: '09:30',
        available: false,
        reason: 'Horário ocupado',
      });
      expect(slots.find((s) => s.time === '10:00')?.available).toBe(true);
    });

    it('marks every slot a long appointment overlaps', async () => {
      prisma.availability.findMany.mockResolvedValue([
        { startTime: time('09:00'), endTime: time('12:00') },
      ]);
      prisma.appointment.findMany.mockResolvedValue([
        { startTime: time('09:15'), endTime: time('10:45') },
      ]);

      const slots = await slotsFor();
      const blocked = slots.filter((s) => !s.available).map((s) => s.time);

      expect(blocked).toEqual(['09:00', '09:30', '10:00', '10:30']);
    });

    it('ignores cancelled and no-show appointments when checking conflicts', async () => {
      await slotsFor();

      expect(prisma.appointment.findMany.mock.calls[0][0].where.status).toEqual(
        {
          notIn: ['CANCELED', 'NO_SHOW'],
        },
      );
    });

    it('takes the duration from the chosen service', async () => {
      prisma.service.findFirst.mockResolvedValue({ durationMinutes: 60 });
      prisma.availability.findMany.mockResolvedValue([
        { startTime: time('09:00'), endTime: time('11:00') },
      ]);

      const slots = await slotsFor({ serviceId: 'svc-1' });

      // A 60-minute appointment cannot start at 10:30 and finish by 11:00.
      expect(slots.map((s) => s.time)).toEqual(['09:00', '09:30', '10:00']);
    });

    it('prefers an explicit duration over the service default', async () => {
      prisma.availability.findMany.mockResolvedValue([
        { startTime: time('09:00'), endTime: time('10:00') },
      ]);

      const slots = await slotsFor({ serviceId: 'svc-1', durationMinutes: 60 });

      expect(slots.map((s) => s.time)).toEqual(['09:00']);
      expect(prisma.service.findFirst).not.toHaveBeenCalled();
    });

    it('falls back to thirty minutes when the service states no duration', async () => {
      prisma.service.findFirst.mockResolvedValue({ durationMinutes: null });
      prisma.availability.findMany.mockResolvedValue([
        { startTime: time('09:00'), endTime: time('10:00') },
      ]);

      const slots = await slotsFor({ serviceId: 'svc-1' });
      expect(slots.map((s) => s.time)).toEqual(['09:00', '09:30']);
    });

    it('refuses a service that does not belong to the profile', async () => {
      prisma.service.findFirst.mockResolvedValue(null);
      await expect(slotsFor({ serviceId: 'svc-other' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('offers nothing when the window is shorter than the appointment', async () => {
      prisma.availability.findMany.mockResolvedValue([
        { startTime: time('09:00'), endTime: time('09:20') },
      ]);

      await expect(slotsFor()).resolves.toEqual([]);
    });

    it('rejects a malformed date rather than offering nothing', async () => {
      await expect(slotsFor({ date: '15-06-2026' })).rejects.toThrow(/Data/);
    });

    it('rejects a date that does not exist', async () => {
      await expect(slotsFor({ date: '2026-02-30' })).rejects.toThrow(/Data/);
    });
  });
});
