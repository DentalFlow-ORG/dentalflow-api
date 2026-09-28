import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AppointmentPaymentStatus, CanceledBy } from '@prisma/client';

import {
  AppointmentIdParamDto,
  AvailabilityParamDto,
} from './appointment-param.dto';
import { ListAppointmentsQueryDto } from './appointment-query.dto';
import { CancelAppointmentDto } from './cancel-appointment.dto';
import { CreateAppointmentDto } from './create-appointment.dto';
import { CreateAvailabilityDto } from './create-availability.dto';
import { GetAvailableSlotsDto } from './get-available-slots.dto';
import { UpdateAppointmentDto } from './update-appointment.dto';
import { UpdateAppointmentPaymentDto } from './update-appointment-payment.dto';
import { UpdateAvailabilityExceptionDto } from './update-availability-exception.dto';

async function validateDto<T extends object>(
  cls: new () => T,
  payload: Record<string, unknown>,
) {
  return validate(plainToInstance(cls, payload));
}

describe('appointments DTO validation', () => {
  it('rejects invalid list date', async () => {
    const errors = await validateDto(ListAppointmentsQueryDto, {
      date: '2026-02-31',
    });

    expect(errors.some((error) => error.property === 'date')).toBe(true);
  });

  it('rejects invalid and overlong IDs', async () => {
    const invalid = await validateDto(AppointmentIdParamDto, { id: '../appt' });
    const overlong = await validateDto(AvailabilityParamDto, {
      profileId: 'profile_1',
      availabilityId: 'a'.repeat(65),
    });
    const query = await validateDto(GetAvailableSlotsDto, {
      profileId: 'profile_1',
      date: '2026-05-22',
      serviceId: 'service/1',
    });

    expect(invalid.some((error) => error.property === 'id')).toBe(true);
    expect(overlong.some((error) => error.property === 'availabilityId')).toBe(
      true,
    );
    expect(query.some((error) => error.property === 'serviceId')).toBe(true);
  });

  // Appointment phones are stored as digits only (DDD + number), like user and
  // clinic phones; the mask is presentation. The API stays tolerant of masked
  // input and normalizes it.
  describe('patient phone normalization', () => {
    const base = {
      profileId: 'profile_1',
      patientName: 'Paciente',
      appointmentDate: '2026-05-22',
      startTime: '09:00',
    };

    it.each([
      ['(11) 99999-8888', '11999998888'],
      ['11 99999 8888', '11999998888'],
      ['(61) 3333-4444', '6133334444'],
      ['11999998888', '11999998888'],
      ['+55 11 99999-8888', '11999998888'],
    ])('stores %j as %j on create and update', async (input, digits) => {
      const created = plainToInstance(CreateAppointmentDto, {
        ...base,
        patientPhone: input,
      });
      const updated = plainToInstance(UpdateAppointmentDto, {
        patientPhone: input,
      });
      expect(await validate(created)).toEqual([]);
      expect(await validate(updated)).toEqual([]);
      expect(created.patientPhone).toBe(digits);
      expect(updated.patientPhone).toBe(digits);
    });

    it.each(['1199999', '(11) 99999-88881', '+44 11 99999-8888', 'abc'])(
      'rejects %j, which is not a 10–11 digit Brazilian number',
      async (input) => {
        const errors = await validateDto(CreateAppointmentDto, {
          ...base,
          patientPhone: input,
        });
        expect(errors.some((error) => error.property === 'patientPhone')).toBe(
          true,
        );
      },
    );
  });

  it('rejects invalid time shape and range', async () => {
    const shape = await validateDto(CreateAppointmentDto, {
      profileId: 'profile_1',
      patientName: 'Paciente',
      patientPhone: '(11) 99999-9999',
      appointmentDate: '2026-05-22',
      startTime: '9:00',
    });
    const range = await validateDto(CreateAvailabilityDto, {
      dayOfWeek: 1,
      startTime: '99:99',
      endTime: '18:00',
    });

    expect(shape.some((error) => error.property === 'startTime')).toBe(true);
    expect(range.some((error) => error.property === 'startTime')).toBe(true);
  });

  it('rejects overlarge cent values', async () => {
    const create = await validateDto(CreateAppointmentDto, {
      profileId: 'profile_1',
      patientName: 'Paciente',
      patientPhone: '(11) 99999-9999',
      appointmentDate: '2026-05-22',
      startTime: '09:00',
      estimatedAmountCents: 1_000_000_000,
    });
    const payment = await validateDto(UpdateAppointmentPaymentDto, {
      paymentStatus: AppointmentPaymentStatus.PAID,
      paidAmountCents: 1_000_000_000,
    });

    expect(
      create.some((error) => error.property === 'estimatedAmountCents'),
    ).toBe(true);
    expect(payment.some((error) => error.property === 'paidAmountCents')).toBe(
      true,
    );
  });

  it('rejects missing or empty required fields', async () => {
    const missing = await validateDto(CreateAppointmentDto, {
      patientPhone: '(11) 99999-9999',
      appointmentDate: '2026-05-22',
      startTime: '09:00',
    });
    const empty = await validateDto(CreateAppointmentDto, {
      profileId: 'profile_1',
      patientName: '   ',
      patientPhone: '(11) 99999-9999',
      appointmentDate: '2026-05-22',
      startTime: '09:00',
    });

    expect(missing.some((error) => error.property === 'profileId')).toBe(true);
    expect(empty.some((error) => error.property === 'patientName')).toBe(true);
  });

  it('rejects overlong notes and payment notes', async () => {
    const appointment = await validateDto(CreateAppointmentDto, {
      profileId: 'profile_1',
      patientName: 'Paciente',
      patientPhone: '(11) 99999-9999',
      appointmentDate: '2026-05-22',
      startTime: '09:00',
      notes: 'a'.repeat(2001),
    });
    const payment = await validateDto(UpdateAppointmentPaymentDto, {
      paymentStatus: AppointmentPaymentStatus.PAYMENT_PENDING,
      paymentNotes: 'a'.repeat(501),
    });

    expect(appointment.some((error) => error.property === 'notes')).toBe(true);
    expect(payment.some((error) => error.property === 'paymentNotes')).toBe(
      true,
    );
  });

  it('validates cancel origin and cancellation reason length', async () => {
    const invalidOrigin = await validateDto(CancelAppointmentDto, {
      canceledBy: 'OTHER',
    });
    const overlongReason = await validateDto(CancelAppointmentDto, {
      canceledBy: CanceledBy.CLINIC,
      cancellationReason: 'a'.repeat(501),
    });

    expect(invalidOrigin.some((error) => error.property === 'canceledBy')).toBe(
      true,
    );
    expect(
      overlongReason.some((error) => error.property === 'cancellationReason'),
    ).toBe(true);
  });

  describe('UpdateAppointmentDto PATCH contract', () => {
    it.each(['serviceId', 'patientEmail', 'notes', 'estimatedAmountCents'])(
      'accepts null to clear %s',
      async (field) => {
        const errors = await validateDto(UpdateAppointmentDto, {
          [field]: null,
        });
        expect(errors).toHaveLength(0);
      },
    );

    it('turns a blank e-mail or note into null', async () => {
      const dto = plainToInstance(UpdateAppointmentDto, {
        patientEmail: '  ',
        notes: '',
      });
      expect(await validate(dto)).toHaveLength(0);
      expect(dto.patientEmail).toBeNull();
      expect(dto.notes).toBeNull();
    });

    it.each([
      'patientName',
      'patientPhone',
      'appointmentDate',
      'startTime',
      'durationMinutes',
    ])('refuses null for %s', async (field) => {
      const errors = await validateDto(UpdateAppointmentDto, {
        [field]: null,
      });
      expect(errors.some((error) => error.property === field)).toBe(true);
    });

    it('refuses a blank patient name', async () => {
      const errors = await validateDto(UpdateAppointmentDto, {
        patientName: '   ',
      });
      expect(errors.some((error) => error.property === 'patientName')).toBe(
        true,
      );
    });
  });

  describe('UpdateAppointmentPaymentDto clears', () => {
    it('accepts null for the estimate and the payment method', async () => {
      const errors = await validateDto(UpdateAppointmentPaymentDto, {
        paymentStatus: AppointmentPaymentStatus.PAYMENT_PENDING,
        estimatedAmountCents: null,
        paymentMethod: null,
      });
      expect(errors).toHaveLength(0);
    });
  });

  describe('UpdateAvailabilityExceptionDto', () => {
    it('clears the reason with null or a blank string', async () => {
      const fromBlank = plainToInstance(UpdateAvailabilityExceptionDto, {
        reason: '  ',
      });
      expect(await validate(fromBlank)).toHaveLength(0);
      expect(fromBlank.reason).toBeNull();
      expect(
        await validateDto(UpdateAvailabilityExceptionDto, { reason: null }),
      ).toHaveLength(0);
    });

    it('refuses null for isDayOff', async () => {
      const errors = await validateDto(UpdateAvailabilityExceptionDto, {
        isDayOff: null,
      });
      expect(errors.some((error) => error.property === 'isDayOff')).toBe(true);
    });
  });
});
