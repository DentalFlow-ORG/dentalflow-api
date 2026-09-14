import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AppointmentPaymentStatus,
  AppointmentStatus,
  UserRole,
} from '@prisma/client';

import { AppointmentsService } from './appointments.service';
import { CreateAppointmentDto } from './dto/create-appointment.dto';

const CLINIC_ID = 'clinic-1';
const USER_ID = 'user-1';
const PROFILE_ID = 'profile-1';
const SERVICE_ID = 'service-1';
const PATIENT_USER_ID = 'patient-1';
const APPOINTMENT_ID = 'appointment-1';
const APPOINTMENT_DATE = '2099-01-02';
const START_TIME = '09:00';

const availabilityRange = {
  startTime: new Date('1970-01-01T08:00:00.000Z'),
  endTime: new Date('1970-01-01T18:00:00.000Z'),
};

const txMock = {
  $queryRaw: jest.fn(),
  appointment: {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  availabilityException: {
    findFirst: jest.fn(),
  },
  availability: {
    findMany: jest.fn(),
  },
  clinic: {
    findUnique: jest.fn(),
  },
  profile: {
    findFirst: jest.fn(),
  },
  service: {
    findFirst: jest.fn(),
  },
  lead: {
    findFirst: jest.fn(),
  },
  user: {
    findFirst: jest.fn(),
  },
};

const prismaMock = {
  $transaction: jest.fn((callback: (tx: typeof txMock) => unknown) =>
    callback(txMock),
  ),
  appointment: {
    findFirst: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  clinic: {
    findUnique: jest.fn(),
  },
};

const calendarIntegrationsMock = {
  deleteAppointmentEvent: jest.fn(),
};

const auditLogMock = {
  log: jest.fn(),
};

function createDto(
  overrides: Partial<CreateAppointmentDto> = {},
): CreateAppointmentDto {
  return {
    profileId: PROFILE_ID,
    patientName: 'Paciente Teste',
    patientPhone: '(11) 99999-9999',
    appointmentDate: APPOINTMENT_DATE,
    startTime: START_TIME,
    durationMinutes: 30,
    ...overrides,
  };
}

function existingAppointment(overrides: Record<string, unknown> = {}) {
  return {
    id: APPOINTMENT_ID,
    clinicId: CLINIC_ID,
    profileId: PROFILE_ID,
    serviceId: null,
    patientUserId: null,
    patientName: 'Paciente Teste',
    patientEmail: null,
    patientPhone: '(11) 99999-9999',
    appointmentDate: new Date(`${APPOINTMENT_DATE}T00:00:00.000Z`),
    startTime: new Date('1970-01-01T09:00:00.000Z'),
    endTime: new Date('1970-01-01T09:30:00.000Z'),
    durationMinutes: 30,
    status: AppointmentStatus.PENDING,
    service: null,
    profile: { userId: USER_ID },
    ...overrides,
  };
}

function createdAppointment() {
  return existingAppointment();
}

describe('AppointmentsService scheduling concurrency', () => {
  let service: AppointmentsService;

  beforeEach(() => {
    jest.clearAllMocks();
    txMock.profile.findFirst.mockResolvedValue({
      id: PROFILE_ID,
      userId: USER_ID,
    });
    txMock.clinic.findUnique.mockResolvedValue({
      timezone: 'America/Sao_Paulo',
    });
    txMock.availabilityException.findFirst.mockResolvedValue(null);
    txMock.availability.findMany.mockResolvedValue([availabilityRange]);
    txMock.service.findFirst.mockResolvedValue({
      id: SERVICE_ID,
      durationMinutes: 30,
    });
    txMock.user.findFirst.mockResolvedValue({ id: PATIENT_USER_ID });
    txMock.appointment.findFirst.mockResolvedValue(null);
    txMock.appointment.create.mockResolvedValue(createdAppointment());
    txMock.appointment.update.mockResolvedValue(createdAppointment());

    service = new AppointmentsService(
      prismaMock as never,
      calendarIntegrationsMock as never,
      auditLogMock as never,
    );
  });

  it('create acquires advisory lock before conflict check and write', async () => {
    await service.createAppointment(
      CLINIC_ID,
      USER_ID,
      UserRole.OWNER,
      createDto(),
    );

    expect(txMock.$queryRaw).toHaveBeenCalledTimes(1);
    expect(txMock.appointment.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        clinicId: CLINIC_ID,
        profileId: PROFILE_ID,
        status: { notIn: ['CANCELED', 'NO_SHOW'] },
      }),
      select: { id: true },
    });
    expect(txMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      txMock.appointment.findFirst.mock.invocationCallOrder[0],
    );
    expect(txMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      txMock.appointment.create.mock.invocationCallOrder[0],
    );
  });

  it('create rejects overlapping conflict and does not create appointment', async () => {
    txMock.appointment.findFirst.mockResolvedValueOnce({
      id: 'other-appointment',
    });

    await expect(
      service.createAppointment(
        CLINIC_ID,
        USER_ID,
        UserRole.OWNER,
        createDto(),
      ),
    ).rejects.toThrow(ConflictException);

    expect(txMock.appointment.create).not.toHaveBeenCalled();
  });

  it('create uses clinicId, profileId, date, time overlap and active-status conflict filtering', async () => {
    await service.createAppointment(
      CLINIC_ID,
      USER_ID,
      UserRole.OWNER,
      createDto(),
    );

    expect(txMock.appointment.findFirst).toHaveBeenCalledWith({
      where: {
        clinicId: CLINIC_ID,
        profileId: PROFILE_ID,
        appointmentDate: new Date(`${APPOINTMENT_DATE}T00:00:00.000Z`),
        status: { notIn: ['CANCELED', 'NO_SHOW'] },
        startTime: { lt: new Date('1970-01-01T09:30:00.000Z') },
        endTime: { gt: new Date('1970-01-01T09:00:00.000Z') },
      },
      select: { id: true },
    });
  });

  it('update acquires advisory lock and checks conflict inside transaction', async () => {
    txMock.appointment.findFirst
      .mockResolvedValueOnce(existingAppointment())
      .mockResolvedValueOnce(null);

    await service.updateAppointment(
      CLINIC_ID,
      USER_ID,
      UserRole.OWNER,
      APPOINTMENT_ID,
      { startTime: '10:00', durationMinutes: 30 },
    );

    expect(txMock.$queryRaw).toHaveBeenCalledTimes(1);
    expect(txMock.appointment.findFirst).toHaveBeenNthCalledWith(2, {
      where: expect.objectContaining({
        clinicId: CLINIC_ID,
        profileId: PROFILE_ID,
        id: { not: APPOINTMENT_ID },
      }),
      select: { id: true },
    });
    expect(txMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      txMock.appointment.findFirst.mock.invocationCallOrder[1],
    );
    expect(txMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      txMock.appointment.update.mock.invocationCallOrder[0],
    );
  });

  it('update ignores the current appointment but rejects another overlapping appointment', async () => {
    txMock.appointment.findFirst
      .mockResolvedValueOnce(existingAppointment())
      .mockResolvedValueOnce({ id: 'other-appointment' });

    await expect(
      service.updateAppointment(
        CLINIC_ID,
        USER_ID,
        UserRole.OWNER,
        APPOINTMENT_ID,
        { startTime: '10:00', durationMinutes: 30 },
      ),
    ).rejects.toThrow(ConflictException);

    expect(txMock.appointment.findFirst).toHaveBeenNthCalledWith(2, {
      where: expect.objectContaining({ id: { not: APPOINTMENT_ID } }),
      select: { id: true },
    });
    expect(txMock.appointment.update).not.toHaveBeenCalled();
  });

  it('keeps CANCELED and NO_SHOW excluded from conflict checks', async () => {
    await service.createAppointment(
      CLINIC_ID,
      USER_ID,
      UserRole.OWNER,
      createDto(),
    );

    expect(txMock.appointment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { notIn: ['CANCELED', 'NO_SHOW'] },
        }),
      }),
    );
  });

  it('allows non-overlapping appointments to be created', async () => {
    txMock.appointment.findFirst.mockResolvedValueOnce(null);

    const result = await service.createAppointment(
      CLINIC_ID,
      USER_ID,
      UserRole.OWNER,
      createDto({ startTime: '11:00', durationMinutes: 30 }),
    );

    expect(txMock.appointment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          clinicId: CLINIC_ID,
          profileId: PROFILE_ID,
          startTime: new Date('1970-01-01T11:00:00.000Z'),
          endTime: new Date('1970-01-01T11:30:00.000Z'),
        }),
      }),
    );
    expect(result).toMatchObject({ id: APPOINTMENT_ID });
  });

  it('preserves tenant, profile, service and patient access checks inside create transaction', async () => {
    await service.createAppointment(
      CLINIC_ID,
      USER_ID,
      UserRole.OWNER,
      createDto({
        serviceId: SERVICE_ID,
        patientUserId: PATIENT_USER_ID,
      }),
    );

    expect(txMock.profile.findFirst).toHaveBeenCalledWith({
      where: { id: PROFILE_ID, clinicId: CLINIC_ID },
      select: { id: true, userId: true },
    });
    expect(txMock.service.findFirst).toHaveBeenCalledWith({
      where: {
        id: SERVICE_ID,
        clinicId: CLINIC_ID,
        profileId: PROFILE_ID,
        isActive: true,
      },
      select: { id: true, durationMinutes: true },
    });
    expect(txMock.user.findFirst).toHaveBeenCalledWith({
      where: {
        id: PATIENT_USER_ID,
        role: 'PATIENT',
        clinicId: null,
        isActive: true,
        deletedAt: null,
      },
      select: { id: true },
    });
  });
});

describe('AppointmentsService status and payment guards', () => {
  let service: AppointmentsService;

  const pendingAppointment = {
    id: APPOINTMENT_ID,
    status: AppointmentStatus.PENDING,
    appointmentDate: new Date(`${APPOINTMENT_DATE}T00:00:00.000Z`),
    startTime: new Date('1970-01-01T09:00:00.000Z'),
    profile: { userId: USER_ID },
  };

  beforeEach(() => {
    prismaMock.appointment.findFirst.mockResolvedValue(pendingAppointment);
    prismaMock.appointment.update.mockResolvedValue({
      ...pendingAppointment,
      status: AppointmentStatus.CONFIRMED,
    });
    prismaMock.clinic.findUnique.mockResolvedValue({
      timezone: 'America/Sao_Paulo',
    });
    calendarIntegrationsMock.deleteAppointmentEvent.mockResolvedValue(
      undefined,
    );

    service = new AppointmentsService(
      prismaMock as never,
      calendarIntegrationsMock as never,
      auditLogMock as never,
    );
  });

  describe('cancelAppointment guard', () => {
    it('throws UnprocessableEntityException when status is COMPLETED', async () => {
      prismaMock.appointment.findFirst.mockResolvedValue({
        ...pendingAppointment,
        status: AppointmentStatus.COMPLETED,
      });

      await expect(
        service.cancelAppointment(
          CLINIC_ID,
          USER_ID,
          UserRole.OWNER,
          APPOINTMENT_ID,
        ),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('throws UnprocessableEntityException when status is CANCELED', async () => {
      prismaMock.appointment.findFirst.mockResolvedValue({
        ...pendingAppointment,
        status: AppointmentStatus.CANCELED,
      });

      await expect(
        service.cancelAppointment(
          CLINIC_ID,
          USER_ID,
          UserRole.OWNER,
          APPOINTMENT_ID,
        ),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('throws NotFoundException when appointment does not belong to clinic', async () => {
      prismaMock.appointment.findFirst.mockResolvedValue(null);

      await expect(
        service.cancelAppointment(
          CLINIC_ID,
          USER_ID,
          UserRole.OWNER,
          APPOINTMENT_ID,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateAppointmentStatus', () => {
    it('throws UnprocessableEntityException for COMPLETED → CANCELED transition', async () => {
      prismaMock.appointment.findFirst.mockResolvedValue({
        ...pendingAppointment,
        status: AppointmentStatus.COMPLETED,
      });

      await expect(
        service.updateAppointmentStatus(
          CLINIC_ID,
          USER_ID,
          UserRole.OWNER,
          APPOINTMENT_ID,
          { status: AppointmentStatus.CANCELED },
        ),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('throws UnprocessableEntityException for PENDING → NO_SHOW transition', async () => {
      await expect(
        service.updateAppointmentStatus(
          CLINIC_ID,
          USER_ID,
          UserRole.OWNER,
          APPOINTMENT_ID,
          { status: AppointmentStatus.NO_SHOW },
        ),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('throws ForbiddenException when DENTIST attempts to CONFIRM', async () => {
      await expect(
        service.updateAppointmentStatus(
          CLINIC_ID,
          USER_ID,
          UserRole.DENTIST,
          APPOINTMENT_ID,
          { status: AppointmentStatus.CONFIRMED },
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('transitions PENDING → CONFIRMED successfully', async () => {
      const confirmed = {
        ...pendingAppointment,
        status: AppointmentStatus.CONFIRMED,
      };
      prismaMock.appointment.update.mockResolvedValue(confirmed);

      const result = await service.updateAppointmentStatus(
        CLINIC_ID,
        USER_ID,
        UserRole.OWNER,
        APPOINTMENT_ID,
        { status: AppointmentStatus.CONFIRMED },
      );

      expect(prismaMock.appointment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: APPOINTMENT_ID },
          data: expect.objectContaining({
            status: AppointmentStatus.CONFIRMED,
          }),
        }),
      );
      expect(result).toMatchObject({ status: AppointmentStatus.CONFIRMED });
    });
  });

  describe('updateAppointmentPayment', () => {
    it('throws NotFoundException for cross-clinic appointment', async () => {
      prismaMock.appointment.findFirst.mockResolvedValue(null);

      await expect(
        service.updateAppointmentPayment(CLINIC_ID, USER_ID, APPOINTMENT_ID, {
          paymentStatus: AppointmentPaymentStatus.PAID,
          paidAmountCents: 5000,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when status is PAID with no paidAmountCents', async () => {
      prismaMock.appointment.findFirst.mockResolvedValue({
        id: APPOINTMENT_ID,
        clinicId: CLINIC_ID,
        serviceId: null,
        profileId: 'profile-1',
        patientName: 'Paciente',
        service: null,
        profile: { id: 'profile-1' },
      });

      await expect(
        service.updateAppointmentPayment(CLINIC_ID, USER_ID, APPOINTMENT_ID, {
          paymentStatus: AppointmentPaymentStatus.PAID,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
