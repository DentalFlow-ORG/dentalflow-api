import { createPatientResolverMock } from '../../../test/support/patient-resolver.mock';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { ClinicalRecordStatus, UserRole } from '@prisma/client';

import { ClinicalRecordsService } from './clinical-records.service';

/**
 * Everything hanging off a clinical record: attachments, templates, the
 * printable view, the patient timeline and the odontogram.
 *
 * The record lifecycle itself has a suite. These surfaces had none, and three
 * of them carry the same rule the record does — a DENTIST reaches only their
 * own patients, and a locked record is not editable. A guard that holds on the
 * record but not on its attachments protects nothing.
 *
 * The patient identifier is worth reading closely. A patient here is an email
 * address or, failing that, a name; matching by name must also require the
 * email to be null, or one patient's history merges into another's.
 */

const CLINIC = 'clinic-1';
const RECORD = 'record-1';
const ATTACHMENT = 'attachment-1';
const TEMPLATE = 'template-1';
const DENTIST_USER = 'dentist-1';
const OWNER_USER = 'owner-1';

const DENTIST: UserRole = 'DENTIST';
const OWNER: UserRole = 'OWNER';

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: RECORD,
    clinicId: CLINIC,
    status: 'DRAFT' as ClinicalRecordStatus,
    patientName: 'Maria Silva',
    patientEmail: 'maria@example.test',
    profile: { userId: DENTIST_USER },
    ...overrides,
  };
}

function createPrisma() {
  return {
    clinicalRecord: {
      findFirst: jest.fn().mockResolvedValue(record()),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ id: RECORD }),
    },
    clinicalRecordAttachment: {
      findFirst: jest.fn().mockResolvedValue({ id: ATTACHMENT }),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: ATTACHMENT }),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    clinicalTemplate: {
      findFirst: jest.fn().mockResolvedValue({ id: TEMPLATE }),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: TEMPLATE }),
      update: jest.fn().mockResolvedValue({}),
    },
    odontogramRecord: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'odontogram-1' }),
      update: jest.fn().mockResolvedValue({ id: 'odontogram-1' }),
    },
    clinic: { findUnique: jest.fn().mockResolvedValue({ name: 'Clínica' }) },
  };
}

describe('ClinicalRecordsService — attachments, templates and views', () => {
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

  // ── Attachments ────────────────────────────────────────────────────────────

  describe('attachments', () => {
    const png = {
      fileName: 'radiografia.png',
      fileType: 'image/png',
      sizeBytes: 500_000,
    };

    it('lists them oldest first for the record', async () => {
      await service.listAttachments(CLINIC, OWNER_USER, OWNER, RECORD);

      expect(prisma.clinicalRecordAttachment.findMany).toHaveBeenCalledWith({
        where: { clinicalRecordId: RECORD },
        orderBy: { createdAt: 'asc' },
      });
    });

    it('refuses to list them for another professional’s record', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(
        record({ profile: { userId: 'another-dentist' } }),
      );

      await expect(
        service.listAttachments(CLINIC, DENTIST_USER, DENTIST, RECORD),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.clinicalRecordAttachment.findMany).not.toHaveBeenCalled();
    });

    it('reports a record from another clinic as not found', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(null);

      await expect(
        service.listAttachments(CLINIC, OWNER_USER, OWNER, 'foreign'),
      ).rejects.toThrow(NotFoundException);
    });

    it('stores the attachment against the record and the uploader', async () => {
      await service.addAttachmentMetadata(
        CLINIC,
        OWNER_USER,
        OWNER,
        RECORD,
        png,
      );

      expect(
        prisma.clinicalRecordAttachment.create.mock.calls[0][0].data,
      ).toMatchObject({
        clinicId: CLINIC,
        clinicalRecordId: RECORD,
        fileName: 'radiografia.png',
        fileType: 'image/png',
        uploadedByUserId: OWNER_USER,
      });
    });

    it('accepts mimeType as an alias for fileType', async () => {
      await service.addAttachmentMetadata(CLINIC, OWNER_USER, OWNER, RECORD, {
        fileName: 'foto.jpg',
        mimeType: 'image/jpeg',
      });

      expect(
        prisma.clinicalRecordAttachment.create.mock.calls[0][0].data.fileType,
      ).toBe('image/jpeg');
    });

    it.each(['image/jpeg', 'image/png', 'image/webp'])(
      'accepts %s',
      async (mime) => {
        await expect(
          service.addAttachmentMetadata(CLINIC, OWNER_USER, OWNER, RECORD, {
            fileName: 'imagem',
            fileType: mime,
          }),
        ).resolves.toBeDefined();
      },
    );

    it.each(['application/pdf', 'image/svg+xml', 'text/html'])(
      'refuses %s',
      async (mime) => {
        // An attachment is rendered back to a browser; anything that is not a
        // raster image is a delivery vehicle rather than a radiograph.
        await expect(
          service.addAttachmentMetadata(CLINIC, OWNER_USER, OWNER, RECORD, {
            fileName: 'arquivo',
            fileType: mime,
          }),
        ).rejects.toThrow(BadRequestException);
        expect(prisma.clinicalRecordAttachment.create).not.toHaveBeenCalled();
      },
    );

    it('refuses an image over 2 MB', async () => {
      await expect(
        service.addAttachmentMetadata(CLINIC, OWNER_USER, OWNER, RECORD, {
          ...png,
          sizeBytes: 2 * 1024 * 1024 + 1,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts one at exactly 2 MB', async () => {
      await expect(
        service.addAttachmentMetadata(CLINIC, OWNER_USER, OWNER, RECORD, {
          ...png,
          sizeBytes: 2 * 1024 * 1024,
        }),
      ).resolves.toBeDefined();
    });

    it('refuses to attach to a record that is no longer a draft', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(
        record({ status: 'SIGNED' as ClinicalRecordStatus }),
      );

      // A signed record is a legal document; adding an image to it after the
      // fact would change what was signed.
      await expect(
        service.addAttachmentMetadata(CLINIC, OWNER_USER, OWNER, RECORD, png),
      ).rejects.toThrow(ForbiddenException);
    });

    it('refuses a dentist attaching to another professional’s record', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(
        record({ profile: { userId: 'another-dentist' } }),
      );

      await expect(
        service.addAttachmentMetadata(
          CLINIC,
          DENTIST_USER,
          DENTIST,
          RECORD,
          png,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('updates a description', async () => {
      await service.updateAttachmentDescription(
        CLINIC,
        OWNER_USER,
        OWNER,
        RECORD,
        ATTACHMENT,
        'Radiografia panorâmica',
      );

      expect(prisma.clinicalRecordAttachment.update).toHaveBeenCalledWith({
        where: { id: ATTACHMENT },
        data: { description: 'Radiografia panorâmica' },
      });
    });

    it('scopes the attachment lookup to its own record', async () => {
      await service.updateAttachmentDescription(
        CLINIC,
        OWNER_USER,
        OWNER,
        RECORD,
        ATTACHMENT,
        'x',
      );

      // Without clinicalRecordId here, an attachment id from another record —
      // in another clinic — would be editable.
      expect(
        prisma.clinicalRecordAttachment.findFirst.mock.calls[0][0].where,
      ).toEqual({ id: ATTACHMENT, clinicalRecordId: RECORD });
    });

    it('reports an attachment belonging to another record as not found', async () => {
      prisma.clinicalRecordAttachment.findFirst.mockResolvedValue(null);

      await expect(
        service.updateAttachmentDescription(
          CLINIC,
          OWNER_USER,
          OWNER,
          RECORD,
          'foreign',
          'x',
        ),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.clinicalRecordAttachment.update).not.toHaveBeenCalled();
    });

    it('removes an attachment', async () => {
      await service.removeAttachment(
        CLINIC,
        OWNER_USER,
        OWNER,
        RECORD,
        ATTACHMENT,
      );

      expect(prisma.clinicalRecordAttachment.delete).toHaveBeenCalledWith({
        where: { id: ATTACHMENT },
      });
    });

    it('refuses to remove one from a record that is no longer a draft', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(
        record({ status: 'SIGNED' as ClinicalRecordStatus }),
      );

      await expect(
        service.removeAttachment(CLINIC, OWNER_USER, OWNER, RECORD, ATTACHMENT),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.clinicalRecordAttachment.delete).not.toHaveBeenCalled();
    });

    it('deletes nothing when the attachment is not on this record', async () => {
      prisma.clinicalRecordAttachment.findFirst.mockResolvedValue(null);

      await expect(
        service.removeAttachment(CLINIC, OWNER_USER, OWNER, RECORD, 'foreign'),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.clinicalRecordAttachment.delete).not.toHaveBeenCalled();
    });
  });

  // ── Templates ──────────────────────────────────────────────────────────────

  describe('clinical templates', () => {
    it('lists the active ones for the clinic, grouped by category', async () => {
      await service.listTemplates(CLINIC);

      expect(prisma.clinicalTemplate.findMany).toHaveBeenCalledWith({
        where: { clinicId: CLINIC, isActive: true },
        orderBy: [{ category: 'asc' }, { name: 'asc' }],
      });
    });

    it('creates one inside the clinic, crediting the author', async () => {
      await service.createTemplate(CLINIC, OWNER_USER, {
        name: 'Anamnese padrão',
        category: 'ANAMNESIS',
        content: 'texto',
      } as never);

      expect(
        prisma.clinicalTemplate.create.mock.calls[0][0].data,
      ).toMatchObject({
        clinicId: CLINIC,
        name: 'Anamnese padrão',
        isActive: true,
        createdByUserId: OWNER_USER,
      });
    });

    it('honours an explicitly inactive template', async () => {
      await service.createTemplate(CLINIC, OWNER_USER, {
        name: 'Rascunho',
        category: 'ANAMNESIS',
        content: 'texto',
        isActive: false,
      } as never);

      expect(
        prisma.clinicalTemplate.create.mock.calls[0][0].data.isActive,
      ).toBe(false);
    });

    it('reports a template from another clinic as not found', async () => {
      prisma.clinicalTemplate.findFirst.mockResolvedValue(null);

      await expect(
        service.updateTemplate(CLINIC, 'foreign', { name: 'x' } as never),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.clinicalTemplate.update).not.toHaveBeenCalled();
    });

    it('scopes the template lookup to the clinic', async () => {
      await service.updateTemplate(CLINIC, TEMPLATE, { name: 'x' } as never);

      expect(prisma.clinicalTemplate.findFirst.mock.calls[0][0].where).toEqual({
        id: TEMPLATE,
        clinicId: CLINIC,
      });
    });

    it('deactivates rather than deletes', async () => {
      await service.deactivateTemplate(CLINIC, TEMPLATE);

      // Records may reference the template's text; removing the row would
      // orphan them.
      expect(prisma.clinicalTemplate.update).toHaveBeenCalledWith({
        where: { id: TEMPLATE },
        data: { isActive: false },
      });
    });

    it('refuses to deactivate one from another clinic', async () => {
      prisma.clinicalTemplate.findFirst.mockResolvedValue(null);

      await expect(
        service.deactivateTemplate(CLINIC, 'foreign'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── Printing ───────────────────────────────────────────────────────────────

  describe('the printable record', () => {
    it('returns the record together with the clinic letterhead', async () => {
      const result = await service.getPrintData(
        CLINIC,
        OWNER_USER,
        OWNER,
        RECORD,
      );

      expect(result.record).toMatchObject({ id: RECORD });
      expect(result.clinic).toMatchObject({ name: 'Clínica' });
    });

    it('stamps when the record was printed', async () => {
      await service.getPrintData(CLINIC, OWNER_USER, OWNER, RECORD);

      const data = prisma.clinicalRecord.update.mock.calls[0][0].data as {
        printedAt: Date;
      };
      expect(data.printedAt).toBeInstanceOf(Date);
    });

    it('scopes the record to the clinic', async () => {
      await service.getPrintData(CLINIC, OWNER_USER, OWNER, RECORD);

      expect(prisma.clinicalRecord.findFirst.mock.calls[0][0].where).toEqual({
        id: RECORD,
        clinicId: CLINIC,
      });
    });

    it('reports a record from another clinic as not found', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(null);

      await expect(
        service.getPrintData(CLINIC, OWNER_USER, OWNER, 'foreign'),
      ).rejects.toThrow(NotFoundException);
    });

    it('refuses a dentist printing another professional’s record', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(
        record({ profile: { userId: 'another-dentist' } }),
      );

      await expect(
        service.getPrintData(CLINIC, DENTIST_USER, DENTIST, RECORD),
      ).rejects.toThrow(ForbiddenException);
      // And nothing is stamped as printed.
      expect(prisma.clinicalRecord.update).not.toHaveBeenCalled();
    });
  });

  // ── Patient timeline ───────────────────────────────────────────────────────

  describe('the patient timeline', () => {
    it('matches on the email address when the identifier is one', async () => {
      await service.getPatientTimeline(
        CLINIC,
        OWNER_USER,
        OWNER,
        'maria@example.test',
      );

      expect(prisma.clinicalRecord.findMany.mock.calls[0][0].where).toEqual({
        clinicId: CLINIC,
        patientId: null,
        patientEmail: { equals: 'maria@example.test', mode: 'insensitive' },
      });
    });

    it('matches on the name only for patients with no email on file', async () => {
      await service.getPatientTimeline(
        CLINIC,
        OWNER_USER,
        OWNER,
        'Maria Silva',
      );

      // Without `patientEmail: null`, a name match would sweep in the records
      // of every other patient who happens to share the name.
      expect(prisma.clinicalRecord.findMany.mock.calls[0][0].where).toEqual({
        clinicId: CLINIC,
        patientId: null,
        patientName: { equals: 'Maria Silva', mode: 'insensitive' },
        patientEmail: null,
      });
    });

    it('narrows a dentist to their own records', async () => {
      await service.getPatientTimeline(
        CLINIC,
        DENTIST_USER,
        DENTIST,
        'maria@example.test',
      );

      expect(
        prisma.clinicalRecord.findMany.mock.calls[0][0].where.profile,
      ).toEqual({ userId: DENTIST_USER });
    });

    it('places no such narrowing on an owner', async () => {
      await service.getPatientTimeline(
        CLINIC,
        OWNER_USER,
        OWNER,
        'maria@example.test',
      );

      expect(
        prisma.clinicalRecord.findMany.mock.calls[0][0].where,
      ).not.toHaveProperty('profile');
    });

    it('returns the history newest first, echoing the identifier', async () => {
      const result = await service.getPatientTimeline(
        CLINIC,
        OWNER_USER,
        OWNER,
        'maria@example.test',
      );

      expect(prisma.clinicalRecord.findMany.mock.calls[0][0].orderBy).toEqual({
        createdAt: 'desc',
      });
      expect(result.identifier).toBe('maria@example.test');
    });
  });

  // ── Odontogram ─────────────────────────────────────────────────────────────

  describe('saving an odontogram', () => {
    const chart = { teeth: [] } as never;

    it('creates one for a patient identified by email', async () => {
      await service.upsertOdontogram(
        CLINIC,
        OWNER_USER,
        OWNER,
        'maria@example.test',
        'Maria Silva',
        chart,
      );

      expect(
        prisma.odontogramRecord.create.mock.calls[0][0].data,
      ).toMatchObject({
        clinicId: CLINIC,
        patientEmail: 'maria@example.test',
        patientName: 'Maria Silva',
        createdByUserId: OWNER_USER,
      });
    });

    it('leaves the email null for a patient identified by name', async () => {
      await service.upsertOdontogram(
        CLINIC,
        OWNER_USER,
        OWNER,
        'Maria Silva',
        'Maria Silva',
        chart,
      );

      expect(
        prisma.odontogramRecord.create.mock.calls[0][0].data.patientEmail,
      ).toBeNull();
    });

    it('updates the existing chart rather than adding a second', async () => {
      prisma.odontogramRecord.findFirst.mockResolvedValue({
        id: 'odontogram-1',
      });

      await service.upsertOdontogram(
        CLINIC,
        OWNER_USER,
        OWNER,
        'maria@example.test',
        'Maria Silva',
        chart,
      );

      expect(prisma.odontogramRecord.update).toHaveBeenCalledWith({
        where: { id: 'odontogram-1' },
        data: { data: chart, createdByUserId: OWNER_USER },
      });
      expect(prisma.odontogramRecord.create).not.toHaveBeenCalled();
    });

    it('looks for the existing chart inside the clinic only', async () => {
      await service.upsertOdontogram(
        CLINIC,
        OWNER_USER,
        OWNER,
        'maria@example.test',
        'Maria Silva',
        chart,
      );

      expect(prisma.odontogramRecord.findFirst.mock.calls[0][0].where).toEqual({
        clinicId: CLINIC,
        patientId: null,
        patientEmail: { equals: 'maria@example.test', mode: 'insensitive' },
      });
    });

    it('refuses a dentist writing the chart of a patient who is not theirs', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(null);

      await expect(
        service.upsertOdontogram(
          CLINIC,
          DENTIST_USER,
          DENTIST,
          'maria@example.test',
          'Maria Silva',
          chart,
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.odontogramRecord.create).not.toHaveBeenCalled();
      expect(prisma.odontogramRecord.update).not.toHaveBeenCalled();
    });

    it('allows a dentist who has treated the patient', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue({ id: RECORD });

      await expect(
        service.upsertOdontogram(
          CLINIC,
          DENTIST_USER,
          DENTIST,
          'maria@example.test',
          'Maria Silva',
          chart,
        ),
      ).resolves.toBeDefined();
    });

    it('checks the dentist’s claim against their own records only', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue({ id: RECORD });

      await service.upsertOdontogram(
        CLINIC,
        DENTIST_USER,
        DENTIST,
        'Maria Silva',
        'Maria Silva',
        chart,
      );

      expect(prisma.clinicalRecord.findFirst.mock.calls[0][0].where).toEqual({
        clinicId: CLINIC,
        patientId: null,
        patientName: { equals: 'Maria Silva', mode: 'insensitive' },
        patientEmail: null,
        profile: { userId: DENTIST_USER },
      });
    });

    it('asks nothing of the database for an owner’s claim', async () => {
      await service.upsertOdontogram(
        CLINIC,
        OWNER_USER,
        OWNER,
        'maria@example.test',
        'Maria Silva',
        chart,
      );

      expect(prisma.clinicalRecord.findFirst).not.toHaveBeenCalled();
    });
  });

  // ── Dictation gate ─────────────────────────────────────────────────────────

  describe('validating a record for dictation', () => {
    it('passes for a draft the caller owns', async () => {
      await expect(
        service.validateRecordForDictation(
          CLINIC,
          DENTIST_USER,
          DENTIST,
          RECORD,
        ),
      ).resolves.toBeUndefined();
    });

    it('refuses a record from another clinic', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(null);

      await expect(
        service.validateRecordForDictation(
          CLINIC,
          OWNER_USER,
          OWNER,
          'foreign',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('refuses another professional’s record', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(
        record({ profile: { userId: 'another-dentist' } }),
      );

      await expect(
        service.validateRecordForDictation(
          CLINIC,
          DENTIST_USER,
          DENTIST,
          RECORD,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('refuses a record that is no longer a draft', async () => {
      prisma.clinicalRecord.findFirst.mockResolvedValue(
        record({ status: 'SIGNED' as ClinicalRecordStatus }),
      );

      await expect(
        service.validateRecordForDictation(CLINIC, OWNER_USER, OWNER, RECORD),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
