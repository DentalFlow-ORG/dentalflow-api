import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { UpdateAppointmentDto } from './dto/update-appointment.dto';
import { UpdateAppointmentStatusDto } from './dto/update-appointment-status.dto';
import { CreateAvailabilityDto } from './dto/create-availability.dto';
import { UpdateAvailabilityDto } from './dto/update-availability.dto';
import { CreateAvailabilityExceptionDto } from './dto/create-availability-exception.dto';
import { UpdateAvailabilityExceptionDto } from './dto/update-availability-exception.dto';
import { GetAvailableSlotsDto } from './dto/get-available-slots.dto';
import { CalendarIntegrationsService } from '../calendar-integrations/calendar-integrations.service';

const APPOINTMENT_INCLUDE = {
  profile: { select: { id: true, displayName: true, userId: true } },
  service: { select: { id: true, name: true, durationMinutes: true } },
  patient: {
    select: { id: true, firstName: true, lastName: true, email: true },
  },
} as const;

// Default working hours applied when a professional has no availability configured.
// Mon=1 … Fri=5; weekends (0=Sun, 6=Sat) are unavailable.
const DEFAULT_BUSINESS_HOURS = {
  startTime: new Date('1970-01-01T08:00:00.000Z'),
  endTime: new Date('1970-01-01T18:00:00.000Z'),
  weekdays: [1, 2, 3, 4, 5],
} as const;

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calendarIntegrations: CalendarIntegrationsService,
  ) {}

  async listAppointments(
    clinicId: string,
    userId: string,
    role: UserRole,
    date?: string,
  ) {
    let dateFilter = {};
    if (date) {
      const [y, m, d] = date.split('-').map(Number);
      dateFilter = {
        appointmentDate: {
          gte: new Date(Date.UTC(y, m - 1, d)),
          lt: new Date(Date.UTC(y, m - 1, d + 1)),
        },
      };
    }

    return this.prisma.appointment.findMany({
      where: {
        clinicId,
        ...(role === 'DENTIST' ? { profile: { userId } } : {}),
        ...dateFilter,
      },
      include: APPOINTMENT_INCLUDE,
      orderBy: [{ appointmentDate: 'asc' }, { startTime: 'asc' }],
    });
  }

  async findAppointmentById(
    clinicId: string,
    userId: string,
    role: UserRole,
    appointmentId: string,
  ) {
    const appointment = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, clinicId },
      include: APPOINTMENT_INCLUDE,
    });
    if (!appointment) throw new NotFoundException('Consulta não encontrada');
    this.assertDentistAppointmentAccess(
      role,
      userId,
      appointment.profile.userId,
    );
    return appointment;
  }

  async createAppointment(
    clinicId: string,
    userId: string,
    role: UserRole,
    dto: CreateAppointmentDto,
  ) {
    const profile = await this.assertProfileInClinic(clinicId, dto.profileId);
    this.assertDentistAppointmentAccess(role, userId, profile.userId);

    const service = dto.serviceId
      ? await this.assertServiceInProfile(
          clinicId,
          dto.profileId,
          dto.serviceId,
        )
      : null;

    if (dto.leadId) {
      await this.assertLeadInClinic(clinicId, dto.leadId);
    }
    if (dto.patientUserId) {
      await this.assertPatientUser(dto.patientUserId);
    }

    const durationMinutes =
      dto.durationMinutes ?? service?.durationMinutes ?? 30;
    const appointmentDate = parseDate(dto.appointmentDate);
    const startTime = parseTime(dto.startTime);
    const endTime = addMinutes(startTime, durationMinutes);
    await this.assertAppointmentIsNotInPast(
      clinicId,
      dto.appointmentDate,
      dto.startTime,
    );

    await this.assertProfileAvailability(
      clinicId,
      profile.id,
      appointmentDate,
      startTime,
      endTime,
    );
    await this.assertNoAppointmentConflict(
      clinicId,
      profile.id,
      appointmentDate,
      startTime,
      endTime,
    );

    return this.prisma.appointment.create({
      data: {
        clinicId,
        profileId: profile.id,
        serviceId: service?.id,
        leadId: dto.leadId,
        patientUserId: dto.patientUserId,
        patientName: dto.patientName,
        patientEmail: dto.patientEmail,
        patientPhone: dto.patientPhone,
        appointmentDate,
        startTime,
        endTime,
        durationMinutes,
        notes: dto.notes,
        patientNotes: dto.patientNotes,
        status: 'PENDING',
      },
      include: APPOINTMENT_INCLUDE,
    });
  }

  async updateAppointment(
    clinicId: string,
    userId: string,
    role: UserRole,
    appointmentId: string,
    dto: UpdateAppointmentDto,
  ) {
    const existing = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, clinicId },
      include: {
        service: true,
        profile: { select: { userId: true } },
      },
    });
    if (!existing) throw new NotFoundException('Consulta não encontrada');
    this.assertDentistAppointmentAccess(role, userId, existing.profile.userId);

    if (dto.patientUserId) {
      await this.assertPatientUser(dto.patientUserId);
    }

    const service = dto.serviceId
      ? await this.assertServiceInProfile(
          clinicId,
          existing.profileId,
          dto.serviceId,
        )
      : existing.service;
    const durationMinutes =
      dto.durationMinutes ??
      service?.durationMinutes ??
      existing.durationMinutes;
    const appointmentDate = dto.appointmentDate
      ? parseDate(dto.appointmentDate)
      : existing.appointmentDate;
    const startTime = dto.startTime
      ? parseTime(dto.startTime)
      : existing.startTime;
    const endTime = addMinutes(startTime, durationMinutes);
    await this.assertAppointmentIsNotInPast(
      clinicId,
      formatDateInputValue(appointmentDate),
      formatTimeInputValue(startTime),
    );

    await this.assertProfileAvailability(
      clinicId,
      existing.profileId,
      appointmentDate,
      startTime,
      endTime,
    );
    await this.assertNoAppointmentConflict(
      clinicId,
      existing.profileId,
      appointmentDate,
      startTime,
      endTime,
      appointmentId,
    );

    const scheduleChanged = Boolean(
      dto.appointmentDate || dto.startTime || dto.durationMinutes,
    );

    return this.prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        serviceId: dto.serviceId,
        patientUserId: dto.patientUserId,
        patientName: dto.patientName,
        patientEmail: dto.patientEmail,
        patientPhone: dto.patientPhone,
        appointmentDate,
        startTime,
        endTime,
        durationMinutes,
        status:
          existing.status === 'NO_SHOW' && scheduleChanged
            ? 'PENDING'
            : undefined,
        notes: dto.notes,
        patientNotes: dto.patientNotes,
      },
      include: APPOINTMENT_INCLUDE,
    });
  }

  async updateAppointmentStatus(
    clinicId: string,
    userId: string,
    role: UserRole,
    appointmentId: string,
    dto: UpdateAppointmentStatusDto,
  ) {
    const appointment = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, clinicId },
      select: {
        id: true,
        profile: { select: { userId: true } },
      },
    });
    if (!appointment) throw new NotFoundException('Consulta não encontrada');
    this.assertDentistAppointmentAccess(
      role,
      userId,
      appointment.profile.userId,
    );

    if (role === 'DENTIST' && !['COMPLETED', 'NO_SHOW'].includes(dto.status)) {
      throw new ForbiddenException(
        'Profissionais só podem marcar consultas como concluídas ou não comparecimento',
      );
    }

    if (dto.status === 'CANCELED') {
      await this.calendarIntegrations.deleteAppointmentEvent(
        clinicId,
        appointmentId,
      );
    }

    const now = new Date();
    return this.prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        status: dto.status,
        confirmedAt: dto.status === 'CONFIRMED' ? now : undefined,
        completedAt: dto.status === 'COMPLETED' ? now : undefined,
        canceledAt: dto.status === 'CANCELED' ? now : undefined,
        canceledBy:
          dto.status === 'CANCELED' ? (dto.canceledBy ?? 'CLINIC') : undefined,
        cancellationReason:
          dto.status === 'CANCELED' ? dto.cancellationReason : undefined,
      },
      include: APPOINTMENT_INCLUDE,
    });
  }

  async cancelAppointment(
    clinicId: string,
    userId: string,
    role: UserRole,
    appointmentId: string,
    dto?: Pick<UpdateAppointmentStatusDto, 'canceledBy' | 'cancellationReason'>,
  ) {
    const appointment = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, clinicId },
      select: {
        id: true,
        profile: { select: { userId: true } },
      },
    });
    if (!appointment) throw new NotFoundException('Consulta não encontrada');
    this.assertDentistAppointmentAccess(
      role,
      userId,
      appointment.profile.userId,
    );

    return this.updateAppointmentStatus(clinicId, userId, role, appointmentId, {
      status: 'CANCELED',
      canceledBy: dto?.canceledBy ?? 'CLINIC',
      cancellationReason: dto?.cancellationReason,
    });
  }

  async listAvailability(
    clinicId: string,
    userId: string,
    role: UserRole,
    profileId: string,
  ) {
    await this.assertProfileAccess(clinicId, userId, role, profileId);
    return this.prisma.availability.findMany({
      where: { clinicId, profileId },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    });
  }

  async createAvailability(
    clinicId: string,
    userId: string,
    role: UserRole,
    profileId: string,
    dto: CreateAvailabilityDto,
  ) {
    await this.assertProfileAccess(clinicId, userId, role, profileId);
    const startTime = parseTime(dto.startTime);
    const endTime = parseTime(dto.endTime);
    assertValidTimeRange(startTime, endTime);

    return this.prisma.availability.create({
      data: {
        clinicId,
        profileId,
        dayOfWeek: dto.dayOfWeek,
        startTime,
        endTime,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async updateAvailability(
    clinicId: string,
    userId: string,
    role: UserRole,
    profileId: string,
    availabilityId: string,
    dto: UpdateAvailabilityDto,
  ) {
    await this.assertProfileAccess(clinicId, userId, role, profileId);
    const existing = await this.assertAvailabilityInProfile(
      clinicId,
      profileId,
      availabilityId,
    );

    const startTime = dto.startTime
      ? parseTime(dto.startTime)
      : existing.startTime;
    const endTime = dto.endTime ? parseTime(dto.endTime) : existing.endTime;
    assertValidTimeRange(startTime, endTime);

    return this.prisma.availability.update({
      where: { id: availabilityId },
      data: {
        dayOfWeek: dto.dayOfWeek,
        startTime,
        endTime,
        isActive: dto.isActive,
      },
    });
  }

  async removeAvailability(
    clinicId: string,
    userId: string,
    role: UserRole,
    profileId: string,
    availabilityId: string,
  ) {
    await this.assertProfileAccess(clinicId, userId, role, profileId);
    await this.assertAvailabilityInProfile(clinicId, profileId, availabilityId);
    await this.prisma.availability.delete({ where: { id: availabilityId } });
  }

  async listAvailabilityExceptions(
    clinicId: string,
    userId: string,
    role: UserRole,
    profileId: string,
  ) {
    await this.assertProfileAccess(clinicId, userId, role, profileId);
    return this.prisma.availabilityException.findMany({
      where: { clinicId, profileId },
      orderBy: { exceptionDate: 'asc' },
    });
  }

  async createAvailabilityException(
    clinicId: string,
    userId: string,
    role: UserRole,
    profileId: string,
    dto: CreateAvailabilityExceptionDto,
  ) {
    await this.assertProfileAccess(clinicId, userId, role, profileId);
    const isDayOff = dto.isDayOff ?? true;
    const startTime = dto.startTime ? parseTime(dto.startTime) : undefined;
    const endTime = dto.endTime ? parseTime(dto.endTime) : undefined;
    if (!isDayOff) {
      if (!startTime || !endTime) {
        throw new ConflictException(
          'Exceções de atendimento exigem horário inicial e final',
        );
      }
      assertValidTimeRange(startTime, endTime);
    }

    return this.prisma.availabilityException.create({
      data: {
        clinicId,
        profileId,
        exceptionDate: parseDate(dto.exceptionDate),
        isDayOff,
        startTime,
        endTime,
        reason: dto.reason,
      },
    });
  }

  async updateAvailabilityException(
    clinicId: string,
    userId: string,
    role: UserRole,
    profileId: string,
    exceptionId: string,
    dto: UpdateAvailabilityExceptionDto,
  ) {
    await this.assertProfileAccess(clinicId, userId, role, profileId);
    const existing = await this.assertAvailabilityExceptionInProfile(
      clinicId,
      profileId,
      exceptionId,
    );
    const isDayOff = dto.isDayOff ?? existing.isDayOff;
    const startTime = dto.startTime
      ? parseTime(dto.startTime)
      : existing.startTime;
    const endTime = dto.endTime ? parseTime(dto.endTime) : existing.endTime;
    if (!isDayOff) {
      if (!startTime || !endTime) {
        throw new ConflictException(
          'Exceções de atendimento exigem horário inicial e final',
        );
      }
      assertValidTimeRange(startTime, endTime);
    }

    return this.prisma.availabilityException.update({
      where: { id: exceptionId },
      data: {
        isDayOff,
        startTime: isDayOff ? null : startTime,
        endTime: isDayOff ? null : endTime,
        reason: dto.reason,
      },
    });
  }

  async removeAvailabilityException(
    clinicId: string,
    userId: string,
    role: UserRole,
    profileId: string,
    exceptionId: string,
  ) {
    await this.assertProfileAccess(clinicId, userId, role, profileId);
    await this.assertAvailabilityExceptionInProfile(
      clinicId,
      profileId,
      exceptionId,
    );
    await this.prisma.availabilityException.delete({
      where: { id: exceptionId },
    });
  }

  async getAvailableSlots(
    clinicId: string,
    dto: GetAvailableSlotsDto,
  ): Promise<{ time: string; available: boolean; reason: string | null }[]> {
    await this.assertProfileInClinic(clinicId, dto.profileId);

    let durationMinutes = dto.durationMinutes;
    if (!durationMinutes && dto.serviceId) {
      const service = await this.assertServiceInProfile(
        clinicId,
        dto.profileId,
        dto.serviceId,
      );
      durationMinutes = service.durationMinutes ?? undefined;
    }
    durationMinutes ??= 30;

    const date = parseDate(dto.date);
    const workingRanges = await this.resolveWorkingRanges(
      clinicId,
      dto.profileId,
      date,
    );

    if (workingRanges.length === 0) return [];

    const existingAppointments = await this.prisma.appointment.findMany({
      where: {
        clinicId,
        profileId: dto.profileId,
        appointmentDate: date,
        status: { notIn: ['CANCELED', 'NO_SHOW'] },
      },
      select: { startTime: true, endTime: true },
    });

    const SLOT_INCREMENT = 30;
    const slots: { time: string; available: boolean; reason: string | null }[] =
      [];

    for (const range of workingRanges) {
      const rangeStartMin = timeToMinutes(range.start);
      const rangeEndMin = timeToMinutes(range.end);

      for (
        let t = rangeStartMin;
        t + durationMinutes <= rangeEndMin;
        t += SLOT_INCREMENT
      ) {
        const slotEnd = t + durationMinutes;
        const conflict = existingAppointments.some(
          (a) =>
            timeToMinutes(a.startTime) < slotEnd &&
            timeToMinutes(a.endTime) > t,
        );
        slots.push({
          time: formatTimeValue(t),
          available: !conflict,
          reason: conflict ? 'Horário ocupado' : null,
        });
      }
    }

    return slots;
  }

  private async resolveWorkingRanges(
    clinicId: string,
    profileId: string,
    date: Date,
  ): Promise<{ start: Date; end: Date }[]> {
    const exception = await this.prisma.availabilityException.findFirst({
      where: { clinicId, profileId, exceptionDate: date },
    });

    if (exception?.isDayOff) return [];

    if (exception?.startTime && exception.endTime) {
      return [{ start: exception.startTime, end: exception.endTime }];
    }

    const availability = await this.prisma.availability.findMany({
      where: {
        clinicId,
        profileId,
        dayOfWeek: date.getUTCDay(),
        isActive: true,
      },
      orderBy: { startTime: 'asc' },
    });

    if (availability.length > 0) {
      return availability.map((a) => ({ start: a.startTime, end: a.endTime }));
    }

    const dow = date.getUTCDay();
    if (!(DEFAULT_BUSINESS_HOURS.weekdays as readonly number[]).includes(dow)) {
      return [];
    }
    return [
      {
        start: DEFAULT_BUSINESS_HOURS.startTime,
        end: DEFAULT_BUSINESS_HOURS.endTime,
      },
    ];
  }

  private async assertProfileAccess(
    clinicId: string,
    userId: string,
    role: UserRole,
    profileId: string,
  ) {
    const profile = await this.assertProfileInClinic(clinicId, profileId);
    this.assertDentistAppointmentAccess(role, userId, profile.userId);
    return profile;
  }

  private async assertProfileInClinic(clinicId: string, profileId: string) {
    const profile = await this.prisma.profile.findFirst({
      where: { id: profileId, clinicId },
      select: { id: true, userId: true },
    });
    if (!profile)
      throw new NotFoundException('Perfil profissional não encontrado');
    return profile;
  }

  private async assertServiceInProfile(
    clinicId: string,
    profileId: string,
    serviceId: string,
  ) {
    const service = await this.prisma.service.findFirst({
      where: { id: serviceId, clinicId, profileId, isActive: true },
      select: { id: true, durationMinutes: true },
    });
    if (!service) throw new NotFoundException('Serviço não encontrado');
    return service;
  }

  private async assertLeadInClinic(clinicId: string, leadId: string) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, clinicId },
      select: { id: true },
    });
    if (!lead) throw new NotFoundException('Lead não encontrado');
  }

  private async assertPatientUser(patientUserId: string) {
    const patient = await this.prisma.user.findFirst({
      where: {
        id: patientUserId,
        role: 'PATIENT',
        clinicId: null,
        isActive: true,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!patient) throw new NotFoundException('Paciente não encontrado');
  }

  private async assertAvailabilityInProfile(
    clinicId: string,
    profileId: string,
    availabilityId: string,
  ) {
    const availability = await this.prisma.availability.findFirst({
      where: { id: availabilityId, clinicId, profileId },
    });
    if (!availability)
      throw new NotFoundException('Disponibilidade não encontrada');
    return availability;
  }

  private async assertAvailabilityExceptionInProfile(
    clinicId: string,
    profileId: string,
    exceptionId: string,
  ) {
    const exception = await this.prisma.availabilityException.findFirst({
      where: { id: exceptionId, clinicId, profileId },
    });
    if (!exception) {
      throw new NotFoundException('Exceção de disponibilidade não encontrada');
    }
    return exception;
  }

  private assertDentistAppointmentAccess(
    role: UserRole,
    userId: string,
    profileUserId: string | null,
  ): void {
    if (role === 'DENTIST' && profileUserId !== userId) {
      throw new ForbiddenException(
        'Profissionais podem acessar apenas a própria agenda',
      );
    }
  }

  private async assertProfileAvailability(
    clinicId: string,
    profileId: string,
    appointmentDate: Date,
    startTime: Date,
    endTime: Date,
  ) {
    const exception = await this.prisma.availabilityException.findFirst({
      where: { clinicId, profileId, exceptionDate: appointmentDate },
    });

    if (exception?.isDayOff) {
      throw new ConflictException('Profissional indisponível nesta data');
    }

    if (exception && exception.startTime && exception.endTime) {
      if (
        isWithinRange(
          startTime,
          endTime,
          exception.startTime,
          exception.endTime,
        )
      ) {
        return;
      }
      throw new ConflictException(
        'Consulta fora da disponibilidade excepcional',
      );
    }

    const availability = await this.prisma.availability.findMany({
      where: {
        clinicId,
        profileId,
        dayOfWeek: appointmentDate.getUTCDay(),
        isActive: true,
      },
    });

    if (availability.length === 0) {
      // No availability configured → fall back to default Mon-Fri 08:00-18:00
      const dow = appointmentDate.getUTCDay();
      if (
        !(DEFAULT_BUSINESS_HOURS.weekdays as readonly number[]).includes(dow)
      ) {
        throw new ConflictException(
          'Profissional não atende neste dia da semana',
        );
      }
      if (
        !isWithinRange(
          startTime,
          endTime,
          DEFAULT_BUSINESS_HOURS.startTime,
          DEFAULT_BUSINESS_HOURS.endTime,
        )
      ) {
        throw new ConflictException(
          'Consulta fora do horário padrão do profissional (08:00 – 18:00)',
        );
      }
      return;
    }

    const matchingAvailability = availability.some((item) =>
      isWithinRange(startTime, endTime, item.startTime, item.endTime),
    );

    if (!matchingAvailability) {
      throw new ConflictException(
        'Consulta fora da disponibilidade do profissional',
      );
    }
  }

  private async assertNoAppointmentConflict(
    clinicId: string,
    profileId: string,
    appointmentDate: Date,
    startTime: Date,
    endTime: Date,
    ignoredAppointmentId?: string,
  ) {
    const existing = await this.prisma.appointment.findFirst({
      where: {
        clinicId,
        profileId,
        appointmentDate,
        status: { notIn: ['CANCELED', 'NO_SHOW'] },
        startTime: { lt: endTime },
        endTime: { gt: startTime },
        ...(ignoredAppointmentId ? { id: { not: ignoredAppointmentId } } : {}),
      },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException('Consulta conflita com outro agendamento');
    }
  }

  private async assertAppointmentIsNotInPast(
    clinicId: string,
    appointmentDate: string,
    startTime: string,
  ) {
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: clinicId },
      select: { timezone: true },
    });
    const now = getZonedDateTimeParts(
      new Date(),
      clinic?.timezone ?? 'America/Sao_Paulo',
    );

    if (
      appointmentDate < now.date ||
      (appointmentDate === now.date && startTime < now.time)
    ) {
      throw new BadRequestException(
        'Consulta não pode ser agendada no passado',
      );
    }
  }
}

function parseDate(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || formatDateInputValue(date) !== value) {
    throw new BadRequestException('Data da consulta inválida');
  }
  return date;
}

function parseTime(value: string): Date {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) {
    throw new BadRequestException('Horário da consulta inválido');
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new BadRequestException('Horário da consulta inválido');
  }
  return new Date(`1970-01-01T${value}:00.000Z`);
}

function addMinutes(time: Date, minutes: number): Date {
  return new Date(time.getTime() + minutes * 60_000);
}

function timeToMinutes(time: Date): number {
  return time.getUTCHours() * 60 + time.getUTCMinutes();
}

function assertValidTimeRange(startTime: Date, endTime: Date): void {
  if (timeToMinutes(startTime) >= timeToMinutes(endTime)) {
    throw new ConflictException(
      'Horário inicial deve ser anterior ao horário final',
    );
  }
}

function isWithinRange(
  startTime: Date,
  endTime: Date,
  rangeStart: Date,
  rangeEnd: Date,
): boolean {
  return (
    timeToMinutes(startTime) >= timeToMinutes(rangeStart) &&
    timeToMinutes(endTime) <= timeToMinutes(rangeEnd)
  );
}

function formatTimeValue(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function formatDateInputValue(date: Date): string {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function formatTimeInputValue(time: Date): string {
  return [
    String(time.getUTCHours()).padStart(2, '0'),
    String(time.getUTCMinutes()).padStart(2, '0'),
  ].join(':');
}

function getZonedDateTimeParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const getPart = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '';

  return {
    date: `${getPart('year')}-${getPart('month')}-${getPart('day')}`,
    time: `${getPart('hour')}:${getPart('minute')}`,
  };
}
