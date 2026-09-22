import { createPatientResolverMock } from '../../../test/support/patient-resolver.mock';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { ClinicalRecordStatus } from '@prisma/client';

import { ClinicalRecordsService } from './clinical-records.service';

/**
 * Clinical records — the patient's medical history.
 *
 * Two rule sets carry the weight, and both are legal as much as technical.
 *
 * The lifecycle is DRAFT → COMPLETED → LOCKED, with CANCELED reachable from
 * either of the first two. A locked record is immutable: it is the signed
 * clinical document, and being able to edit one retroactively would destroy
 * its evidentiary value. Only a draft is editable at all.
 *
 * Access is narrower than the clinic. A DENTIST reaches only records belonging
 * to their own profile, and an ASSISTANT — who may schedule and invoice —
 * cannot read or write clinical content at all.
 */

const CLINIC = 'clinic-1';
const RECORD = 'record-1';
const DENTIST_USER = 'dentist-1';

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: RECORD,
    clinicId: CLINIC,
    status: 'DRAFT' as ClinicalRecordStatus,
    patientName: 'Maria Silva',
    patientEmail: 'maria@example.test',
    clinicalEvolution: 'Evolução registrada',
    profile: { userId: DENTIST_USER },
    ...overrides,
  };
}

function createPrisma() {
  return {
    clinicalRecord: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: RECORD }),
      update: jest.fn().mockResolvedValue({ id: RECORD }),
    },
    clinicalRecordEvent: {
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    clinicalRecordAttachment: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'attachment-1' }),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    clinicalTemplate: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'template-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    odontogramRecord: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
    appointment: {
      findFirst: jest.fn().mockResolvedValue({ id: 'appointment-1' }),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    profile: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 'profile-1', userId: DENTIST_USER }),
    },
    clinic: { findUnique: jest.fn().mockResolvedValue({ name: 'Clínica' }) },
  };
}

describe('ClinicalRecordsService', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let service: ClinicalRecordsService;

  beforeEach(() => {
    prisma = createPrisma();
    service = new ClinicalRecordsService(
      prisma as never,
      {
        assertUnambiguousIdentity: jest.fn().mockResolvedValue(undefined),
        isAmbiguousIdentity: jest.fn().mockResolvedValue(false),
      } as never,
      createPatientResolverMock() as never,
    );
  });

  // ── Reading ────────────────────────────────────────────────────────────────

  describe('reading', () => {
    it('scopes a record lookup to the clinic', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(record());

      await service.findRecordById(CLINIC, 'owner-1', 'OWNER', RECORD);

      expect(
        prisma.clinicalRecord.findFirst.mock.calls[0][0].where,
      ).toMatchObject({
        id: RECORD,
        clinicId: CLINIC,
      });
    });

    it('reports an unknown record as not found', async () => {
      await expect(
        service.findRecordById(CLINIC, 'owner-1', 'OWNER', 'ghost'),
      ).rejects.toThrow(NotFoundException);
    });

    it('lets a dentist read their own record', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(record());

      await expect(
        service.findRecordById(CLINIC, DENTIST_USER, 'DENTIST', RECORD),
      ).resolves.toBeDefined();
    });

    it('refuses a dentist reading another professional’s record', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(
        record({ profile: { userId: 'another-dentist' } }),
      );

      await expect(
        service.findRecordById(CLINIC, DENTIST_USER, 'DENTIST', RECORD),
      ).rejects.toThrow(ForbiddenException);
    });

    it('narrows the list to a dentist’s own records', async () => {
      await service.listRecords(CLINIC, DENTIST_USER, 'DENTIST');

      expect(
        prisma.clinicalRecord.findMany.mock.calls[0][0].where,
      ).toMatchObject({
        clinicId: CLINIC,
        profile: { userId: DENTIST_USER },
      });
    });

    it('does not narrow the list for an owner', async () => {
      await service.listRecords(CLINIC, 'owner-1', 'OWNER');

      expect(
        prisma.clinicalRecord.findMany.mock.calls[0][0].where,
      ).not.toHaveProperty('profile');
    });

    it('applies a status filter when given', async () => {
      await service.listRecords(CLINIC, 'owner-1', 'OWNER', {
        status: 'COMPLETED',
      });

      expect(prisma.clinicalRecord.findMany.mock.calls[0][0].where.status).toBe(
        'COMPLETED',
      );
    });

    it('lets an owner filter by professional', async () => {
      await service.listRecords(CLINIC, 'owner-1', 'OWNER', {
        dentistProfileId: 'profile-9',
      });

      expect(
        prisma.clinicalRecord.findMany.mock.calls[0][0].where.profileId,
      ).toBe('profile-9');
    });

    it('ignores a professional filter from a dentist — their own scope already applies', async () => {
      await service.listRecords(CLINIC, DENTIST_USER, 'DENTIST', {
        dentistProfileId: 'profile-9',
      });

      expect(
        prisma.clinicalRecord.findMany.mock.calls[0][0].where,
      ).not.toHaveProperty('profileId');
    });

    it('returns null rather than throwing when an appointment has no record yet', async () => {
      await expect(
        service.findByAppointmentId(
          CLINIC,
          'owner-1',
          'OWNER',
          'appointment-1',
        ),
      ).resolves.toBeNull();
    });

    it('refuses to look up a record for an appointment in another clinic', async () => {
      prisma.appointment.findFirst.mockResolvedValue(null);

      await expect(
        service.findByAppointmentId(CLINIC, 'owner-1', 'OWNER', 'foreign'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── Editing ────────────────────────────────────────────────────────────────

  describe('editing', () => {
    it('updates a draft', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(record());

      await service.updateRecord(CLINIC, 'owner-1', 'OWNER', RECORD, {
        diagnosis: 'Cárie oclusal',
      } as never);

      expect(prisma.clinicalRecord.update.mock.calls[0][0].data).toMatchObject({
        diagnosis: 'Cárie oclusal',
        updatedByUserId: 'owner-1',
      });
    });

    it.each(['COMPLETED', 'LOCKED', 'CANCELED'] as ClinicalRecordStatus[])(
      'refuses to edit a %s record',
      async (status) => {
        prisma.clinicalRecord.findFirst.mockResolvedValue(record({ status }));

        await expect(
          service.updateRecord(CLINIC, 'owner-1', 'OWNER', RECORD, {
            diagnosis: 'x',
          } as never),
        ).rejects.toThrow(ForbiddenException);
        expect(prisma.clinicalRecord.update).not.toHaveBeenCalled();
      },
    );

    it('refuses an assistant editing clinical content at all', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(record());

      await expect(
        service.updateRecord(CLINIC, 'assistant-1', 'ASSISTANT', RECORD, {
          diagnosis: 'x',
        } as never),
      ).rejects.toThrow(/Assistentes/);
    });

    it('records who made the change', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(record());

      await service.updateRecord(CLINIC, 'owner-9', 'OWNER', RECORD, {
        diagnosis: 'x',
      } as never);

      expect(
        prisma.clinicalRecord.update.mock.calls[0][0].data.updatedByUserId,
      ).toBe('owner-9');
    });
  });

  // ── Completion ─────────────────────────────────────────────────────────────

  describe('completeRecord', () => {
    it('completes a draft and stamps the time', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(record());

      await service.completeRecord(CLINIC, 'owner-1', 'OWNER', RECORD);

      const data = prisma.clinicalRecord.update.mock.calls[0][0].data;
      expect(data.status).toBe('COMPLETED');
      expect(data.completedAt).toBeInstanceOf(Date);
    });

    it('requires a clinical evolution before completing', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(
        record({ clinicalEvolution: null }),
      );

      await expect(
        service.completeRecord(CLINIC, 'owner-1', 'OWNER', RECORD),
      ).rejects.toThrow(/evolução clínica é obrigatória/);
      expect(prisma.clinicalRecord.update).not.toHaveBeenCalled();
    });

    it.each(['COMPLETED', 'LOCKED', 'CANCELED'] as ClinicalRecordStatus[])(
      'refuses to complete a %s record',
      async (status) => {
        prisma.clinicalRecord.findFirst.mockResolvedValue(record({ status }));

        await expect(
          service.completeRecord(CLINIC, 'owner-1', 'OWNER', RECORD),
        ).rejects.toThrow(BadRequestException);
      },
    );

    it('snapshots the patient’s odontogram at the moment of completion', async () => {
      // Historical records must show the dental chart as it was at the visit,
      // not as it is today.
      prisma.clinicalRecord.findFirst.mockResolvedValue(record());
      prisma.odontogramRecord.findFirst.mockResolvedValue({
        data: { 11: 'CARIES' },
      });

      await service.completeRecord(CLINIC, 'owner-1', 'OWNER', RECORD);

      expect(
        prisma.clinicalRecord.update.mock.calls[0][0].data.odontogramSnapshot,
      ).toEqual({ 11: 'CARIES' });
    });

    it('looks the odontogram up by email when the patient has one', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(record());

      await service.completeRecord(CLINIC, 'owner-1', 'OWNER', RECORD);

      expect(
        prisma.odontogramRecord.findFirst.mock.calls[0][0].where,
      ).toMatchObject({
        clinicId: CLINIC,
        patientEmail: { equals: 'maria@example.test', mode: 'insensitive' },
      });
    });

    it('falls back to name for a patient with no email', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(
        record({ patientEmail: null }),
      );

      await service.completeRecord(CLINIC, 'owner-1', 'OWNER', RECORD);

      expect(
        prisma.odontogramRecord.findFirst.mock.calls[0][0].where,
      ).toMatchObject({
        patientName: { equals: 'Maria Silva', mode: 'insensitive' },
        patientEmail: null,
      });
    });

    it('completes without a snapshot when the patient has no odontogram', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(record());

      await service.completeRecord(CLINIC, 'owner-1', 'OWNER', RECORD);

      expect(
        prisma.clinicalRecord.update.mock.calls[0][0].data,
      ).not.toHaveProperty('odontogramSnapshot');
    });

    it('still completes when the snapshot lookup fails', async () => {
      // The snapshot is a convenience; losing it must not block the clinician
      // from closing the record.
      prisma.clinicalRecord.findFirst.mockResolvedValue(record());
      prisma.odontogramRecord.findFirst.mockRejectedValue(new Error('db blip'));

      await expect(
        service.completeRecord(CLINIC, 'owner-1', 'OWNER', RECORD),
      ).resolves.toBeDefined();
    });

    it('writes an audit event for the transition', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(record());

      await service.completeRecord(CLINIC, 'owner-1', 'OWNER', RECORD);

      expect(
        prisma.clinicalRecordEvent.create.mock.calls[0][0].data,
      ).toMatchObject({
        eventType: 'COMPLETED',
        previousStatus: 'DRAFT',
        nextStatus: 'COMPLETED',
        createdByUserId: 'owner-1',
      });
    });
  });

  // ── Locking ────────────────────────────────────────────────────────────────

  describe('lockRecord', () => {
    it('locks a completed record and stamps the time', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(
        record({ status: 'COMPLETED' }),
      );

      await service.lockRecord(CLINIC, 'owner-1', 'OWNER', RECORD);

      const data = prisma.clinicalRecord.update.mock.calls[0][0].data;
      expect(data.status).toBe('LOCKED');
      expect(data.lockedAt).toBeInstanceOf(Date);
    });

    it.each(['DRAFT', 'LOCKED', 'CANCELED'] as ClinicalRecordStatus[])(
      'refuses to lock a %s record',
      async (status) => {
        prisma.clinicalRecord.findFirst.mockResolvedValue(record({ status }));

        await expect(
          service.lockRecord(CLINIC, 'owner-1', 'OWNER', RECORD),
        ).rejects.toThrow(/concluídos podem ser bloqueados/);
      },
    );

    it('writes an audit event for the transition', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(
        record({ status: 'COMPLETED' }),
      );

      await service.lockRecord(CLINIC, 'owner-1', 'OWNER', RECORD);

      expect(
        prisma.clinicalRecordEvent.create.mock.calls[0][0].data,
      ).toMatchObject({
        eventType: 'LOCKED',
        previousStatus: 'COMPLETED',
        nextStatus: 'LOCKED',
      });
    });
  });

  // ── Cancellation and restoration ───────────────────────────────────────────

  describe('cancelRecord', () => {
    it.each(['DRAFT', 'COMPLETED'] as ClinicalRecordStatus[])(
      'cancels a %s record',
      async (status) => {
        prisma.clinicalRecord.findFirst.mockResolvedValue(record({ status }));

        await service.cancelRecord(CLINIC, 'owner-1', 'OWNER', RECORD);

        expect(prisma.clinicalRecord.update.mock.calls[0][0].data.status).toBe(
          'CANCELED',
        );
      },
    );

    it('refuses to cancel a locked record', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(
        record({ status: 'LOCKED' }),
      );

      await expect(
        service.cancelRecord(CLINIC, 'owner-1', 'OWNER', RECORD),
      ).rejects.toThrow(/bloqueado/);
      expect(prisma.clinicalRecord.update).not.toHaveBeenCalled();
    });

    it('refuses to cancel an already-cancelled record', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(
        record({ status: 'CANCELED' }),
      );

      await expect(
        service.cancelRecord(CLINIC, 'owner-1', 'OWNER', RECORD),
      ).rejects.toThrow(/já foi cancelado/);
    });

    it('remembers the status it was cancelled from', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(
        record({ status: 'COMPLETED' }),
      );

      await service.cancelRecord(CLINIC, 'owner-1', 'OWNER', RECORD);

      expect(
        prisma.clinicalRecordEvent.create.mock.calls[0][0].data,
      ).toMatchObject({
        eventType: 'CANCELED',
        previousStatus: 'COMPLETED',
      });
    });
  });

  describe('restoreRecord', () => {
    it('restores to the status the record held before cancellation', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(
        record({ status: 'CANCELED' }),
      );
      prisma.clinicalRecordEvent.findFirst.mockResolvedValue({
        previousStatus: 'COMPLETED',
      });

      await service.restoreRecord(CLINIC, 'owner-1', 'OWNER', RECORD);

      expect(prisma.clinicalRecord.update.mock.calls[0][0].data.status).toBe(
        'COMPLETED',
      );
    });

    it('falls back to DRAFT when no cancellation event survives', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(
        record({ status: 'CANCELED' }),
      );

      await service.restoreRecord(CLINIC, 'owner-1', 'OWNER', RECORD);

      expect(prisma.clinicalRecord.update.mock.calls[0][0].data.status).toBe(
        'DRAFT',
      );
    });

    it.each(['DRAFT', 'COMPLETED', 'LOCKED'] as ClinicalRecordStatus[])(
      'refuses to restore a %s record',
      async (status) => {
        prisma.clinicalRecord.findFirst.mockResolvedValue(record({ status }));

        await expect(
          service.restoreRecord(CLINIC, 'owner-1', 'OWNER', RECORD),
        ).rejects.toThrow(/cancelados podem ser restaurados/);
      },
    );

    it('reads the most recent cancellation event, not the first', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(
        record({ status: 'CANCELED' }),
      );

      await service.restoreRecord(CLINIC, 'owner-1', 'OWNER', RECORD);

      expect(
        prisma.clinicalRecordEvent.findFirst.mock.calls[0][0],
      ).toMatchObject({
        where: { clinicalRecordId: RECORD, eventType: 'CANCELED' },
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  // ── Dentist scope applies to every mutation ────────────────────────────────

  describe('dentist scope', () => {
    const foreign = () =>
      prisma.clinicalRecord.findFirst.mockResolvedValue(
        record({ status: 'COMPLETED', profile: { userId: 'another-dentist' } }),
      );

    it.each([
      [
        'updateRecord',
        () =>
          service.updateRecord(
            CLINIC,
            DENTIST_USER,
            'DENTIST',
            RECORD,
            {} as never,
          ),
      ],
      [
        'completeRecord',
        () => service.completeRecord(CLINIC, DENTIST_USER, 'DENTIST', RECORD),
      ],
      [
        'lockRecord',
        () => service.lockRecord(CLINIC, DENTIST_USER, 'DENTIST', RECORD),
      ],
      [
        'cancelRecord',
        () => service.cancelRecord(CLINIC, DENTIST_USER, 'DENTIST', RECORD),
      ],
      [
        'restoreRecord',
        () => service.restoreRecord(CLINIC, DENTIST_USER, 'DENTIST', RECORD),
      ],
    ])('refuses %s on another professional’s record', async (_name, call) => {
      foreign();

      await expect(call()).rejects.toThrow(ForbiddenException);
      expect(prisma.clinicalRecord.update).not.toHaveBeenCalled();
    });
  });

  // ── Templates ──────────────────────────────────────────────────────────────

  describe('templates', () => {
    it('lists only the clinic’s active templates', async () => {
      await service.listTemplates(CLINIC);

      expect(
        prisma.clinicalTemplate.findMany.mock.calls[0][0].where,
      ).toMatchObject({
        clinicId: CLINIC,
      });
    });

    it('creates a template inside the caller’s clinic', async () => {
      await service.createTemplate(CLINIC, 'owner-1', {
        name: 'Anamnese padrão',
        content: 'Modelo',
      } as never);

      expect(
        prisma.clinicalTemplate.create.mock.calls[0][0].data.clinicId,
      ).toBe(CLINIC);
    });

    it('refuses to update a template from another clinic', async () => {
      prisma.clinicalTemplate.findFirst.mockResolvedValue(null);

      await expect(
        service.updateTemplate(CLINIC, 'template-x', { name: 'x' } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it('refuses to deactivate a template from another clinic', async () => {
      prisma.clinicalTemplate.findFirst.mockResolvedValue(null);

      await expect(
        service.deactivateTemplate(CLINIC, 'template-x'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── Attachments ────────────────────────────────────────────────────────────

  describe('attachments', () => {
    it('refuses to list attachments of a record in another clinic', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(null);

      await expect(
        service.listAttachments(CLINIC, 'owner-1', 'OWNER', 'foreign'),
      ).rejects.toThrow(NotFoundException);
    });

    it('refuses to remove an attachment that belongs to another record', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(record());
      prisma.clinicalRecordAttachment.findFirst.mockResolvedValue(null);

      await expect(
        service.removeAttachment(CLINIC, 'owner-1', 'OWNER', RECORD, 'foreign'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── Odontogram ─────────────────────────────────────────────────────────────

  describe('odontogram', () => {
    it('scopes the lookup to the clinic and the patient identifier', async () => {
      await service.getOdontogram(
        CLINIC,
        'owner-1',
        'OWNER',
        'maria@example.test',
      );

      expect(
        prisma.odontogramRecord.findFirst.mock.calls[0][0].where,
      ).toMatchObject({
        clinicId: CLINIC,
        patientEmail: { equals: 'maria@example.test', mode: 'insensitive' },
      });
    });

    it('treats a non-email identifier as a name with no email on file', async () => {
      await service.getOdontogram(CLINIC, 'owner-1', 'OWNER', 'Maria Silva');

      expect(
        prisma.odontogramRecord.findFirst.mock.calls[0][0].where,
      ).toMatchObject({
        patientName: { equals: 'Maria Silva', mode: 'insensitive' },
        patientEmail: null,
      });
    });

    it('refuses a dentist reading the odontogram of a patient who is not theirs', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(null);

      await expect(
        service.getOdontogram(
          CLINIC,
          DENTIST_USER,
          'DENTIST',
          'maria@example.test',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows a dentist who has treated the patient', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue({ id: RECORD });

      await expect(
        service.getOdontogram(
          CLINIC,
          DENTIST_USER,
          'DENTIST',
          'maria@example.test',
        ),
      ).resolves.toBeDefined();
    });

    it('places no such restriction on an owner', async () => {
      await expect(
        service.getOdontogram(CLINIC, 'owner-1', 'OWNER', 'maria@example.test'),
      ).resolves.toBeDefined();
      expect(prisma.clinicalRecord.findFirst).not.toHaveBeenCalled();
    });
  });

  // ── Creation guards ────────────────────────────────────────────────────────

  describe('createRecord', () => {
    const dto = {
      profileId: 'profile-1',
      patientName: 'Maria Silva',
    } as never;

    it('refuses a profile from another clinic', async () => {
      prisma.profile.findFirst.mockResolvedValue(null);

      await expect(
        service.createRecord(CLINIC, 'owner-1', 'OWNER', dto),
      ).rejects.toThrow(NotFoundException);
    });

    it('refuses an appointment from another clinic', async () => {
      prisma.appointment.findFirst.mockResolvedValue(null);

      await expect(
        service.createRecord(CLINIC, 'owner-1', 'OWNER', {
          ...(dto as object),
          appointmentId: 'foreign',
        } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it('refuses a second record for the same appointment', async () => {
      prisma.clinicalRecord.findUnique.mockResolvedValue({ id: 'existing' });

      await expect(
        service.createRecord(CLINIC, 'owner-1', 'OWNER', {
          ...(dto as object),
          appointmentId: 'appointment-1',
        } as never),
      ).rejects.toThrow(/já possui um prontuário/);
    });

    it('refuses a dentist creating a record against another professional’s profile', async () => {
      prisma.profile.findFirst.mockResolvedValue({
        id: 'profile-1',
        userId: 'another-dentist',
      });

      await expect(
        service.createRecord(CLINIC, DENTIST_USER, 'DENTIST', dto),
      ).rejects.toThrow(ForbiddenException);
    });

    it('creates the record inside the caller’s clinic', async () => {
      await service.createRecord(CLINIC, 'owner-1', 'OWNER', dto);

      expect(prisma.clinicalRecord.create.mock.calls[0][0].data.clinicId).toBe(
        CLINIC,
      );
    });

    // ── Contact details inherited from the appointment ──────────────────────
    //
    // A record booked against an appointment should not make the dentist
    // retype the patient's email and phone; they come off the appointment.

    const APPOINTMENT_CONTACT = {
      id: 'appointment-1',
      patientName: 'Maria Silva',
      patientEmail: 'maria@example.test',
      patientPhone: '11999999999',
    };

    it('fills the contact details in from the appointment when the caller omits them', async () => {
      prisma.appointment.findFirst.mockResolvedValue(APPOINTMENT_CONTACT);

      await service.createRecord(CLINIC, 'owner-1', 'OWNER', {
        ...(dto as object),
        appointmentId: 'appointment-1',
      } as never);

      expect(prisma.clinicalRecord.create.mock.calls[0][0].data).toMatchObject({
        patientEmail: 'maria@example.test',
        patientPhone: '11999999999',
      });
    });

    it('keeps the details the caller supplied rather than the appointment’s', async () => {
      prisma.appointment.findFirst.mockResolvedValue(APPOINTMENT_CONTACT);

      await service.createRecord(CLINIC, 'owner-1', 'OWNER', {
        ...(dto as object),
        appointmentId: 'appointment-1',
        patientEmail: 'typed@example.test',
        patientPhone: '11888888888',
      } as never);

      expect(prisma.clinicalRecord.create.mock.calls[0][0].data).toMatchObject({
        patientEmail: 'typed@example.test',
        patientPhone: '11888888888',
      });
    });

    it('reads the appointment once, and always scoped to the clinic', async () => {
      // Both facts matter. The second read used to be an unscoped
      // `findUnique({ where: { id } })` — correct only because the scoped
      // check happened to run first, which is the kind of coupling that
      // survives right up until someone reorders the two.
      prisma.appointment.findFirst.mockResolvedValue(APPOINTMENT_CONTACT);

      await service.createRecord(CLINIC, 'owner-1', 'OWNER', {
        ...(dto as object),
        appointmentId: 'appointment-1',
      } as never);

      expect(prisma.appointment.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.appointment.findUnique).not.toHaveBeenCalled();
      expect(prisma.appointment.findFirst.mock.calls[0][0].where).toMatchObject(
        { id: 'appointment-1', clinicId: CLINIC },
      );
    });
  });
});
