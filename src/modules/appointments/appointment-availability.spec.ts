import { createPatientResolverMock } from '../../../test/support/patient-resolver.mock';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { AppointmentsService } from './appointments.service';

/**
 * The professional's working hours: weekly availability and the exceptions
 * that override it (a day off, or a one-off shift).
 *
 * These are the rules the booking engine reads. Nothing tested them, so the
 * two invariants they exist to hold — a range that ends after it starts, and
 * a professional who can only touch their own agenda — were unenforced by
 * anything but the code itself.
 */

const CLINIC = 'clinic-1';
const OWNER = 'owner-1';
const DENTIST = 'dentist-1';
const PROFILE = 'profile-1';
const AVAILABILITY = 'availability-1';
const EXCEPTION = 'exception-1';

const t = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);

function buildService() {
  const prisma = {
    profile: { findFirst: jest.fn() },
    availability: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: AVAILABILITY }),
      update: jest.fn().mockResolvedValue({ id: AVAILABILITY }),
      delete: jest.fn().mockResolvedValue({ id: AVAILABILITY }),
    },
    availabilityException: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: EXCEPTION }),
      update: jest.fn().mockResolvedValue({ id: EXCEPTION }),
      delete: jest.fn().mockResolvedValue({ id: EXCEPTION }),
    },
  };

  prisma.profile.findFirst.mockResolvedValue({
    id: PROFILE,
    userId: DENTIST,
  });
  prisma.availability.findFirst.mockResolvedValue({
    id: AVAILABILITY,
    clinicId: CLINIC,
    profileId: PROFILE,
    dayOfWeek: 1,
    startTime: t('08:00'),
    endTime: t('12:00'),
    isActive: true,
  });
  prisma.availabilityException.findFirst.mockResolvedValue({
    id: EXCEPTION,
    clinicId: CLINIC,
    profileId: PROFILE,
    exceptionDate: new Date('2026-06-15T00:00:00.000Z'),
    isDayOff: true,
    startTime: null,
    endTime: null,
    reason: null,
  });

  const service = new AppointmentsService(
    prisma as never,
    { deleteAppointmentEvent: jest.fn() } as never,
    { log: jest.fn() } as never,
    createPatientResolverMock() as never,
  );

  return { service, prisma };
}

describe('Availability and its exceptions', () => {
  let service: AppointmentsService;
  let prisma: ReturnType<typeof buildService>['prisma'];

  beforeEach(() => {
    ({ service, prisma } = buildService());
  });

  // ── Weekly availability ────────────────────────────────────────────────────

  describe('weekly availability', () => {
    it('lists only the asked-for profile, inside the caller’s clinic', async () => {
      await service.listAvailability(CLINIC, OWNER, UserRole.OWNER, PROFILE);

      expect(prisma.availability.findMany.mock.calls[0][0].where).toEqual({
        clinicId: CLINIC,
        profileId: PROFILE,
      });
    });

    it('creates a slot with the parsed times and defaults it to active', async () => {
      await service.createAvailability(CLINIC, OWNER, UserRole.OWNER, PROFILE, {
        dayOfWeek: 1,
        startTime: '08:00',
        endTime: '12:00',
      } as never);

      expect(prisma.availability.create.mock.calls[0][0].data).toEqual({
        clinicId: CLINIC,
        profileId: PROFILE,
        dayOfWeek: 1,
        startTime: t('08:00'),
        endTime: t('12:00'),
        isActive: true,
      });
    });

    it('honours isActive when the caller sets it false', async () => {
      await service.createAvailability(CLINIC, OWNER, UserRole.OWNER, PROFILE, {
        dayOfWeek: 1,
        startTime: '08:00',
        endTime: '12:00',
        isActive: false,
      } as never);

      expect(prisma.availability.create.mock.calls[0][0].data.isActive).toBe(
        false,
      );
    });

    it('refuses a range that ends before it starts', async () => {
      await expect(
        service.createAvailability(CLINIC, OWNER, UserRole.OWNER, PROFILE, {
          dayOfWeek: 1,
          startTime: '12:00',
          endTime: '08:00',
        } as never),
      ).rejects.toThrow(ConflictException);

      expect(prisma.availability.create).not.toHaveBeenCalled();
    });

    it('refuses a range of zero length', async () => {
      await expect(
        service.createAvailability(CLINIC, OWNER, UserRole.OWNER, PROFILE, {
          dayOfWeek: 1,
          startTime: '09:00',
          endTime: '09:00',
        } as never),
      ).rejects.toThrow(ConflictException);
    });

    it('keeps the stored time when an update omits it', async () => {
      await service.updateAvailability(
        CLINIC,
        OWNER,
        UserRole.OWNER,
        PROFILE,
        AVAILABILITY,
        { endTime: '13:00' } as never,
      );

      expect(prisma.availability.update.mock.calls[0][0].data).toMatchObject({
        startTime: t('08:00'), // unchanged, read back off the row
        endTime: t('13:00'),
      });
    });

    it('validates the merged range, not just the supplied half', async () => {
      // Stored 08:00–12:00; moving only the start past the stored end has to
      // fail, which it can only do if the check runs after the merge.
      await expect(
        service.updateAvailability(
          CLINIC,
          OWNER,
          UserRole.OWNER,
          PROFILE,
          AVAILABILITY,
          { startTime: '13:00' } as never,
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('reports a slot from another profile as not found', async () => {
      prisma.availability.findFirst.mockResolvedValue(null);

      await expect(
        service.updateAvailability(
          CLINIC,
          OWNER,
          UserRole.OWNER,
          PROFILE,
          'foreign',
          { endTime: '13:00' } as never,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('scopes the delete lookup to the clinic and the profile', async () => {
      await service.removeAvailability(
        CLINIC,
        OWNER,
        UserRole.OWNER,
        PROFILE,
        AVAILABILITY,
      );

      expect(prisma.availability.findFirst.mock.calls[0][0].where).toEqual({
        id: AVAILABILITY,
        clinicId: CLINIC,
        profileId: PROFILE,
      });
      expect(prisma.availability.delete).toHaveBeenCalledWith({
        where: { id: AVAILABILITY },
      });
    });

    it('deletes nothing when the slot belongs to another profile', async () => {
      prisma.availability.findFirst.mockResolvedValue(null);

      await expect(
        service.removeAvailability(
          CLINIC,
          OWNER,
          UserRole.OWNER,
          PROFILE,
          'foreign',
        ),
      ).rejects.toThrow(NotFoundException);

      expect(prisma.availability.delete).not.toHaveBeenCalled();
    });
  });

  // ── Exceptions ─────────────────────────────────────────────────────────────

  describe('exceptions', () => {
    it('treats an exception as a day off unless told otherwise', async () => {
      await service.createAvailabilityException(
        CLINIC,
        OWNER,
        UserRole.OWNER,
        PROFILE,
        { exceptionDate: '2026-06-15' } as never,
      );

      expect(
        prisma.availabilityException.create.mock.calls[0][0].data,
      ).toMatchObject({
        clinicId: CLINIC,
        profileId: PROFILE,
        isDayOff: true,
      });
    });

    it('requires both ends of the range when the day is not off', async () => {
      await expect(
        service.createAvailabilityException(
          CLINIC,
          OWNER,
          UserRole.OWNER,
          PROFILE,
          {
            exceptionDate: '2026-06-15',
            isDayOff: false,
            startTime: '14:00',
          } as never,
        ),
      ).rejects.toThrow(ConflictException);

      expect(prisma.availabilityException.create).not.toHaveBeenCalled();
    });

    it('validates the range of a working exception', async () => {
      await expect(
        service.createAvailabilityException(
          CLINIC,
          OWNER,
          UserRole.OWNER,
          PROFILE,
          {
            exceptionDate: '2026-06-15',
            isDayOff: false,
            startTime: '18:00',
            endTime: '14:00',
          } as never,
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('stores a working exception with its hours', async () => {
      await service.createAvailabilityException(
        CLINIC,
        OWNER,
        UserRole.OWNER,
        PROFILE,
        {
          exceptionDate: '2026-06-15',
          isDayOff: false,
          startTime: '14:00',
          endTime: '18:00',
          reason: 'Plantão',
        } as never,
      );

      expect(
        prisma.availabilityException.create.mock.calls[0][0].data,
      ).toMatchObject({
        isDayOff: false,
        startTime: t('14:00'),
        endTime: t('18:00'),
        reason: 'Plantão',
      });
    });

    it('clears the hours when an exception becomes a day off', async () => {
      prisma.availabilityException.findFirst.mockResolvedValue({
        id: EXCEPTION,
        isDayOff: false,
        startTime: t('14:00'),
        endTime: t('18:00'),
      });

      await service.updateAvailabilityException(
        CLINIC,
        OWNER,
        UserRole.OWNER,
        PROFILE,
        EXCEPTION,
        { isDayOff: true } as never,
      );

      // A day off with hours still attached would be read as a working day by
      // anything that checks the times rather than the flag.
      expect(
        prisma.availabilityException.update.mock.calls[0][0].data,
      ).toMatchObject({ isDayOff: true, startTime: null, endTime: null });
    });

    it('keeps the stored hours when an update only changes the reason', async () => {
      prisma.availabilityException.findFirst.mockResolvedValue({
        id: EXCEPTION,
        isDayOff: false,
        startTime: t('14:00'),
        endTime: t('18:00'),
      });

      await service.updateAvailabilityException(
        CLINIC,
        OWNER,
        UserRole.OWNER,
        PROFILE,
        EXCEPTION,
        { reason: 'Congresso' } as never,
      );

      expect(
        prisma.availabilityException.update.mock.calls[0][0].data,
      ).toMatchObject({
        startTime: t('14:00'),
        endTime: t('18:00'),
        reason: 'Congresso',
      });
    });

    it('reports an exception from another profile as not found', async () => {
      prisma.availabilityException.findFirst.mockResolvedValue(null);

      await expect(
        service.removeAvailabilityException(
          CLINIC,
          OWNER,
          UserRole.OWNER,
          PROFILE,
          'foreign',
        ),
      ).rejects.toThrow(NotFoundException);

      expect(prisma.availabilityException.delete).not.toHaveBeenCalled();
    });

    it('lists exceptions in date order for the profile only', async () => {
      await service.listAvailabilityExceptions(
        CLINIC,
        OWNER,
        UserRole.OWNER,
        PROFILE,
      );

      expect(prisma.availabilityException.findMany.mock.calls[0][0]).toEqual({
        where: { clinicId: CLINIC, profileId: PROFILE },
        orderBy: { exceptionDate: 'asc' },
      });
    });
  });

  // ── Who may edit whose agenda ──────────────────────────────────────────────

  describe('access', () => {
    it('lets a dentist manage their own availability', async () => {
      await expect(
        service.createAvailability(CLINIC, DENTIST, UserRole.DENTIST, PROFILE, {
          dayOfWeek: 1,
          startTime: '08:00',
          endTime: '12:00',
        } as never),
      ).resolves.toBeDefined();
    });

    it('refuses a dentist editing another professional’s availability', async () => {
      prisma.profile.findFirst.mockResolvedValue({
        id: PROFILE,
        userId: 'another-dentist',
      });

      await expect(
        service.createAvailability(CLINIC, DENTIST, UserRole.DENTIST, PROFILE, {
          dayOfWeek: 1,
          startTime: '08:00',
          endTime: '12:00',
        } as never),
      ).rejects.toThrow(ForbiddenException);

      expect(prisma.availability.create).not.toHaveBeenCalled();
    });

    it('refuses a dentist deleting another professional’s exception', async () => {
      prisma.profile.findFirst.mockResolvedValue({
        id: PROFILE,
        userId: 'another-dentist',
      });

      await expect(
        service.removeAvailabilityException(
          CLINIC,
          DENTIST,
          UserRole.DENTIST,
          PROFILE,
          EXCEPTION,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lets an owner manage any professional’s agenda', async () => {
      prisma.profile.findFirst.mockResolvedValue({
        id: PROFILE,
        userId: 'another-dentist',
      });

      await expect(
        service.listAvailability(CLINIC, OWNER, UserRole.OWNER, PROFILE),
      ).resolves.toBeDefined();
    });

    it('reports a profile from another clinic as not found', async () => {
      prisma.profile.findFirst.mockResolvedValue(null);

      await expect(
        service.listAvailability(CLINIC, OWNER, UserRole.OWNER, 'foreign'),
      ).rejects.toThrow(NotFoundException);
    });

    it('scopes the profile lookup to the caller’s clinic', async () => {
      await service.listAvailability(CLINIC, OWNER, UserRole.OWNER, PROFILE);

      expect(prisma.profile.findFirst.mock.calls[0][0].where).toEqual({
        id: PROFILE,
        clinicId: CLINIC,
      });
    });
  });
});
