import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClinicalRecordStatus, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateClinicalRecordDto } from './dto/create-clinical-record.dto';
import { UpdateClinicalRecordDto } from './dto/update-clinical-record.dto';
import { CreateClinicalTemplateDto } from './dto/create-clinical-template.dto';
import { UpdateClinicalTemplateDto } from './dto/update-clinical-template.dto';

const RECORD_INCLUDE = {
  profile: { select: { id: true, displayName: true, userId: true } },
  appointment: {
    select: {
      id: true,
      appointmentDate: true,
      startTime: true,
      endTime: true,
      status: true,
      service: { select: { id: true, name: true } },
    },
  },
  createdByUser: { select: { id: true, firstName: true, lastName: true } },
  updatedByUser: { select: { id: true, firstName: true, lastName: true } },
} as const;

@Injectable()
export class ClinicalRecordsService {
  constructor(private readonly prisma: PrismaService) {}

  // ----------------------------------------------------------------
  // Clinical Records — CRUD
  // ----------------------------------------------------------------

  async listRecords(
    clinicId: string,
    userId: string,
    role: UserRole,
    filters: { status?: ClinicalRecordStatus; dentistProfileId?: string } = {},
  ) {
    return await this.prisma.clinicalRecord.findMany({
      where: {
        clinicId,
        ...(role === 'DENTIST' ? { profile: { userId } } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(role !== 'DENTIST' && filters.dentistProfileId
          ? { profileId: filters.dentistProfileId }
          : {}),
      },
      include: RECORD_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findRecordById(
    clinicId: string,
    userId: string,
    role: UserRole,
    recordId: string,
  ) {
    const record = await this.prisma.clinicalRecord.findFirst({
      where: { id: recordId, clinicId },
      include: RECORD_INCLUDE,
    });
    if (!record) throw new NotFoundException('Prontuário não encontrado');
    this.assertDentistRecordAccess(role, userId, record.profile.userId);
    return record;
  }

  async findByAppointmentId(
    clinicId: string,
    userId: string,
    role: UserRole,
    appointmentId: string,
  ) {
    await this.assertAppointmentInClinic(clinicId, appointmentId);
    const record = await this.prisma.clinicalRecord.findFirst({
      where: { clinicId, appointmentId },
      include: RECORD_INCLUDE,
    });
    if (!record) return null;
    this.assertDentistRecordAccess(role, userId, record.profile.userId);
    return record;
  }

  async createRecord(
    clinicId: string,
    userId: string,
    role: UserRole,
    dto: CreateClinicalRecordDto,
  ) {
    const profile = await this.assertProfileInClinic(clinicId, dto.profileId);
    this.assertDentistRecordAccess(role, userId, profile.userId);

    // One clinic-scoped read serves both purposes: proving the appointment
    // belongs here, and supplying the contact details below.
    const appointment = dto.appointmentId
      ? await this.assertAppointmentInClinic(clinicId, dto.appointmentId)
      : null;

    if (dto.appointmentId) {
      await this.assertNoExistingRecord(dto.appointmentId);
    }

    let patientName = dto.patientName;
    let patientEmail = dto.patientEmail;
    let patientPhone = dto.patientPhone;

    if (appointment && !dto.patientEmail && !dto.patientPhone) {
      patientName = patientName || appointment.patientName;
      patientEmail = patientEmail ?? appointment.patientEmail ?? undefined;
      patientPhone = patientPhone ?? appointment.patientPhone ?? undefined;
    }

    const record = await this.prisma.clinicalRecord.create({
      data: {
        clinicId,
        appointmentId: dto.appointmentId,
        profileId: profile.id,
        patientName,
        patientEmail,
        patientPhone,
        chiefComplaint: dto.chiefComplaint,
        anamnesis: dto.anamnesis,
        clinicalEvolution: dto.clinicalEvolution,
        diagnosis: dto.diagnosis,
        proceduresPerformed: dto.proceduresPerformed,
        treatmentPlan: dto.treatmentPlan,
        prescription: dto.prescription,
        recommendations: dto.recommendations,
        privateNotes: dto.privateNotes,
        status: 'DRAFT',
        createdByUserId: userId,
      },
      include: RECORD_INCLUDE,
    });

    await this.createEvent(
      clinicId,
      record.id,
      userId,
      'CREATED',
      null,
      'DRAFT',
    );
    return record;
  }

  async updateRecord(
    clinicId: string,
    userId: string,
    role: UserRole,
    recordId: string,
    dto: UpdateClinicalRecordDto,
  ) {
    const existing = await this.assertRecordInClinic(clinicId, recordId);
    this.assertDentistRecordAccess(role, userId, existing.profile.userId);
    this.assertRecordEditable(existing.status);
    this.assertClinicalFieldAccess(role, dto);

    return this.prisma.clinicalRecord.update({
      where: { id: recordId },
      data: {
        ...dto,
        updatedByUserId: userId,
      },
      include: RECORD_INCLUDE,
    });
  }

  async completeRecord(
    clinicId: string,
    userId: string,
    role: UserRole,
    recordId: string,
  ) {
    const existing = await this.assertRecordInClinic(clinicId, recordId);
    this.assertDentistRecordAccess(role, userId, existing.profile.userId);

    if (existing.status !== 'DRAFT') {
      throw new BadRequestException(
        'Apenas prontuários em rascunho podem ser concluídos',
      );
    }

    if (!existing.clinicalEvolution) {
      throw new BadRequestException(
        'A evolução clínica é obrigatória para concluir o atendimento',
      );
    }

    // ── Odontogram snapshot ─────────────────────────────────────────────────
    // Capture the current patient-level odontogram as a point-in-time snapshot
    // so historical records show the dental chart state at the time of the visit.
    // Uses the same identifier convention as getOdontogram / upsertOdontogram.
    // This is best-effort: if no odontogram exists or the fetch fails for any
    // reason, completion proceeds and odontogramSnapshot remains null.
    const identifier = existing.patientEmail ?? existing.patientName;
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);
    let snapshotData: Prisma.InputJsonValue | undefined;

    try {
      const odontogramRecord = await this.prisma.odontogramRecord.findFirst({
        where: {
          clinicId,
          ...(isEmail
            ? { patientEmail: identifier }
            : { patientName: identifier, patientEmail: null }),
        },
        orderBy: { updatedAt: 'desc' },
        select: { data: true },
      });
      if (odontogramRecord?.data != null) {
        snapshotData = odontogramRecord.data as Prisma.InputJsonValue;
      }
    } catch {
      // Non-critical — proceed without snapshot rather than aborting completion
    }

    const now = new Date();
    const record = await this.prisma.clinicalRecord.update({
      where: { id: recordId },
      data: {
        status: 'COMPLETED',
        completedAt: now,
        updatedByUserId: userId,
        ...(snapshotData !== undefined
          ? { odontogramSnapshot: snapshotData }
          : {}),
      },
      include: RECORD_INCLUDE,
    });

    await this.createEvent(
      clinicId,
      recordId,
      userId,
      'COMPLETED',
      'DRAFT',
      'COMPLETED',
    );
    return record;
  }

  async lockRecord(
    clinicId: string,
    userId: string,
    role: UserRole,
    recordId: string,
  ) {
    const existing = await this.assertRecordInClinic(clinicId, recordId);
    this.assertDentistRecordAccess(role, userId, existing.profile.userId);

    if (existing.status !== 'COMPLETED') {
      throw new BadRequestException(
        'Apenas prontuários concluídos podem ser bloqueados',
      );
    }

    const now = new Date();
    const record = await this.prisma.clinicalRecord.update({
      where: { id: recordId },
      data: { status: 'LOCKED', lockedAt: now, updatedByUserId: userId },
      include: RECORD_INCLUDE,
    });

    await this.createEvent(
      clinicId,
      recordId,
      userId,
      'LOCKED',
      'COMPLETED',
      'LOCKED',
    );
    return record;
  }

  async cancelRecord(
    clinicId: string,
    userId: string,
    role: UserRole,
    recordId: string,
  ) {
    const existing = await this.assertRecordInClinic(clinicId, recordId);
    this.assertDentistRecordAccess(role, userId, existing.profile.userId);

    if (existing.status === 'LOCKED') {
      throw new BadRequestException(
        'Este prontuário está bloqueado e não pode ser cancelado.',
      );
    }

    if (existing.status === 'CANCELED') {
      throw new BadRequestException('Este prontuário já foi cancelado.');
    }

    const prevStatus = existing.status;
    const record = await this.prisma.clinicalRecord.update({
      where: { id: recordId },
      data: { status: 'CANCELED', updatedByUserId: userId },
      include: RECORD_INCLUDE,
    });

    await this.createEvent(
      clinicId,
      recordId,
      userId,
      'CANCELED',
      prevStatus,
      'CANCELED',
    );
    return record;
  }

  async restoreRecord(
    clinicId: string,
    userId: string,
    role: UserRole,
    recordId: string,
  ) {
    const existing = await this.assertRecordInClinic(clinicId, recordId);
    this.assertDentistRecordAccess(role, userId, existing.profile.userId);

    if (existing.status !== 'CANCELED') {
      throw new BadRequestException(
        'Apenas prontuários cancelados podem ser restaurados',
      );
    }

    // Prefer the most recent pre-cancel status from events; fallback to DRAFT
    const lastEvent = await this.prisma.clinicalRecordEvent.findFirst({
      where: { clinicalRecordId: recordId, eventType: 'CANCELED' },
      orderBy: { createdAt: 'desc' },
    });
    const restoredStatus: ClinicalRecordStatus =
      lastEvent?.previousStatus ?? 'DRAFT';

    const record = await this.prisma.clinicalRecord.update({
      where: { id: recordId },
      data: { status: restoredStatus, updatedByUserId: userId },
      include: RECORD_INCLUDE,
    });

    await this.createEvent(
      clinicId,
      recordId,
      userId,
      'RESTORED',
      'CANCELED',
      restoredStatus,
    );
    return record;
  }

  async getPrintData(
    clinicId: string,
    userId: string,
    role: UserRole,
    recordId: string,
  ) {
    const record = await this.prisma.clinicalRecord.findFirst({
      where: { id: recordId, clinicId },
      include: {
        ...RECORD_INCLUDE,
        attachments: true,
      },
    });
    if (!record) throw new NotFoundException('Prontuário não encontrado');
    this.assertDentistRecordAccess(role, userId, record.profile.userId);

    const clinic = await this.prisma.clinic.findUnique({
      where: { id: clinicId },
      select: {
        name: true,
        email: true,
        phone: true,
        addressLine1: true,
        city: true,
        state: true,
      },
    });

    await this.prisma.clinicalRecord.update({
      where: { id: recordId },
      data: { printedAt: new Date() },
    });

    return { clinic, record };
  }

  // ----------------------------------------------------------------
  // Patient Clinical Timeline
  // ----------------------------------------------------------------

  async getPatientTimeline(
    clinicId: string,
    userId: string,
    role: UserRole,
    identifier: string,
  ) {
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);

    const records = await this.prisma.clinicalRecord.findMany({
      where: {
        clinicId,
        ...(isEmail
          ? { patientEmail: identifier }
          : { patientName: identifier, patientEmail: null }),
        ...(role === 'DENTIST' ? { profile: { userId } } : {}),
      },
      include: RECORD_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });

    return { records, identifier };
  }

  // ----------------------------------------------------------------
  // Clinical Templates
  // ----------------------------------------------------------------

  async listTemplates(clinicId: string) {
    return await this.prisma.clinicalTemplate.findMany({
      where: { clinicId, isActive: true },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
  }

  async createTemplate(
    clinicId: string,
    userId: string,
    dto: CreateClinicalTemplateDto,
  ) {
    return await this.prisma.clinicalTemplate.create({
      data: {
        clinicId,
        name: dto.name,
        category: dto.category,
        content: dto.content,
        isActive: dto.isActive ?? true,
        createdByUserId: userId,
      },
    });
  }

  async updateTemplate(
    clinicId: string,
    templateId: string,
    dto: UpdateClinicalTemplateDto,
  ) {
    const existing = await this.prisma.clinicalTemplate.findFirst({
      where: { id: templateId, clinicId },
    });
    if (!existing) throw new NotFoundException('Modelo clínico não encontrado');

    return this.prisma.clinicalTemplate.update({
      where: { id: templateId },
      data: dto,
    });
  }

  async deactivateTemplate(clinicId: string, templateId: string) {
    const existing = await this.prisma.clinicalTemplate.findFirst({
      where: { id: templateId, clinicId },
    });
    if (!existing) throw new NotFoundException('Modelo clínico não encontrado');

    return this.prisma.clinicalTemplate.update({
      where: { id: templateId },
      data: { isActive: false },
    });
  }

  // ----------------------------------------------------------------
  // Attachments (metadata only)
  // ----------------------------------------------------------------

  async listAttachments(
    clinicId: string,
    userId: string,
    role: UserRole,
    recordId: string,
  ) {
    const record = await this.assertRecordInClinic(clinicId, recordId);
    this.assertDentistRecordAccess(role, userId, record.profile.userId);

    return this.prisma.clinicalRecordAttachment.findMany({
      where: { clinicalRecordId: recordId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addAttachmentMetadata(
    clinicId: string,
    userId: string,
    role: UserRole,
    recordId: string,
    data: {
      fileName: string;
      fileType?: string;
      mimeType?: string;
      sizeBytes?: number;
      dataBase64?: string;
      thumbnailBase64?: string;
      description?: string;
    },
  ) {
    const record = await this.assertRecordInClinic(clinicId, recordId);
    this.assertDentistRecordAccess(role, userId, record.profile.userId);
    this.assertRecordEditable(record.status);

    const MAX_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB after compression
    if (data.sizeBytes && data.sizeBytes > MAX_SIZE_BYTES) {
      throw new BadRequestException(
        'Imagem muito grande. O tamanho máximo é 2 MB após compressão.',
      );
    }

    const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
    const effectiveMime = data.fileType ?? data.mimeType;
    if (effectiveMime && !ALLOWED_MIME_TYPES.includes(effectiveMime)) {
      throw new BadRequestException(
        'Tipo de arquivo não permitido. Envie apenas imagens JPEG, PNG ou WebP.',
      );
    }

    return this.prisma.clinicalRecordAttachment.create({
      data: {
        clinicId,
        clinicalRecordId: recordId,
        fileName: data.fileName,
        fileType: data.fileType ?? data.mimeType,
        sizeBytes: data.sizeBytes,
        dataBase64: data.dataBase64,
        thumbnailBase64: data.thumbnailBase64,
        description: data.description,
        uploadedByUserId: userId,
      },
    });
  }

  async updateAttachmentDescription(
    clinicId: string,
    userId: string,
    role: UserRole,
    recordId: string,
    attachmentId: string,
    description: string,
  ) {
    const record = await this.assertRecordInClinic(clinicId, recordId);
    this.assertDentistRecordAccess(role, userId, record.profile.userId);
    this.assertRecordEditable(record.status);

    const attachment = await this.prisma.clinicalRecordAttachment.findFirst({
      where: { id: attachmentId, clinicalRecordId: recordId },
    });
    if (!attachment) throw new NotFoundException('Anexo não encontrado');

    return this.prisma.clinicalRecordAttachment.update({
      where: { id: attachmentId },
      data: { description },
    });
  }

  async removeAttachment(
    clinicId: string,
    userId: string,
    role: UserRole,
    recordId: string,
    attachmentId: string,
  ) {
    const record = await this.assertRecordInClinic(clinicId, recordId);
    this.assertDentistRecordAccess(role, userId, record.profile.userId);
    this.assertRecordEditable(record.status);

    const attachment = await this.prisma.clinicalRecordAttachment.findFirst({
      where: { id: attachmentId, clinicalRecordId: recordId },
    });
    if (!attachment) throw new NotFoundException('Anexo não encontrado');

    await this.prisma.clinicalRecordAttachment.delete({
      where: { id: attachmentId },
    });
  }

  // ----------------------------------------------------------------
  // Odontogram
  // ----------------------------------------------------------------

  async getOdontogram(
    clinicId: string,
    userId: string,
    role: UserRole,
    identifier: string,
  ) {
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);
    await this.assertDentistOdontogramAccess(
      clinicId,
      userId,
      role,
      identifier,
      isEmail,
    );

    return await this.prisma.odontogramRecord.findFirst({
      where: {
        clinicId,
        ...(isEmail
          ? { patientEmail: identifier }
          : { patientName: identifier, patientEmail: null }),
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async upsertOdontogram(
    clinicId: string,
    userId: string,
    role: UserRole,
    identifier: string,
    patientName: string,
    data: Prisma.InputJsonValue,
  ) {
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);
    await this.assertDentistOdontogramAccess(
      clinicId,
      userId,
      role,
      identifier,
      isEmail,
    );

    const existing = await this.prisma.odontogramRecord.findFirst({
      where: {
        clinicId,
        ...(isEmail
          ? { patientEmail: identifier }
          : { patientName: identifier, patientEmail: null }),
      },
    });

    if (existing) {
      return this.prisma.odontogramRecord.update({
        where: { id: existing.id },
        data: { data, createdByUserId: userId },
      });
    }

    return this.prisma.odontogramRecord.create({
      data: {
        clinicId,
        patientEmail: isEmail ? identifier : null,
        patientName,
        data,
        createdByUserId: userId,
      },
    });
  }

  // ----------------------------------------------------------------
  // Dictation access validation
  // ----------------------------------------------------------------

  /**
   * Verifies that a clinical record can receive dictation results.
   * Reuses existing private access helpers so logic is never duplicated.
   *
   * Throws:
   *   - NotFoundException   — record does not exist in this clinic
   *   - ForbiddenException  — DENTIST does not own the record
   *   - ForbiddenException  — record is not in DRAFT status
   */
  async validateRecordForDictation(
    clinicId: string,
    userId: string,
    role: UserRole,
    recordId: string,
  ): Promise<void> {
    const existing = await this.assertRecordInClinic(clinicId, recordId);
    this.assertDentistRecordAccess(role, userId, existing.profile.userId);
    this.assertRecordEditable(existing.status);
  }

  // ----------------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------------

  private async assertRecordInClinic(clinicId: string, recordId: string) {
    const record = await this.prisma.clinicalRecord.findFirst({
      where: { id: recordId, clinicId },
      include: { profile: { select: { userId: true } } },
    });
    if (!record) throw new NotFoundException('Prontuário não encontrado');
    return record;
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

  private async assertAppointmentInClinic(
    clinicId: string,
    appointmentId: string,
  ) {
    const appt = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, clinicId },
      // The patient columns come along so `createRecord` can inherit the
      // contact details without a second round trip — and, more importantly,
      // without a second lookup that forgets the clinic scope.
      select: {
        id: true,
        patientName: true,
        patientEmail: true,
        patientPhone: true,
      },
    });
    if (!appt) throw new NotFoundException('Consulta não encontrada');
    return appt;
  }

  private async assertNoExistingRecord(appointmentId: string) {
    const existing = await this.prisma.clinicalRecord.findUnique({
      where: { appointmentId },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        'Esta consulta já possui um prontuário vinculado',
      );
    }
  }

  private assertDentistRecordAccess(
    role: UserRole,
    userId: string,
    profileUserId: string | null,
  ): void {
    if (role === 'DENTIST' && profileUserId !== userId) {
      throw new ForbiddenException(
        'Profissionais podem acessar apenas os próprios prontuários',
      );
    }
  }

  private async assertDentistOdontogramAccess(
    clinicId: string,
    userId: string,
    role: UserRole,
    identifier: string,
    isEmail: boolean,
  ): Promise<void> {
    if (role !== 'DENTIST') return;

    const record = await this.prisma.clinicalRecord.findFirst({
      where: {
        clinicId,
        ...(isEmail
          ? { patientEmail: identifier }
          : { patientName: identifier, patientEmail: null }),
        profile: { userId },
      },
      select: { id: true },
    });

    if (!record) {
      throw new ForbiddenException(
        'Profissionais podem acessar apenas o odontograma dos próprios pacientes',
      );
    }
  }

  private assertRecordEditable(status: ClinicalRecordStatus): void {
    if (status !== 'DRAFT') {
      throw new ForbiddenException(
        'Este prontuário não pode ser editado no status atual.',
      );
    }
  }

  private assertClinicalFieldAccess(
    role: UserRole,
    dto: UpdateClinicalRecordDto,
  ): void {
    if (role !== 'ASSISTANT') return;
    if (Object.keys(dto).length > 0) {
      throw new ForbiddenException(
        'Assistentes nao podem editar prontuarios clinicos',
      );
    }

    const restrictedFields: (keyof UpdateClinicalRecordDto)[] = [
      'clinicalEvolution',
      'diagnosis',
      'prescription',
      'privateNotes',
      'proceduresPerformed',
      'treatmentPlan',
    ];

    for (const field of restrictedFields) {
      if (dto[field] !== undefined) {
        throw new ForbiddenException(
          'Assistentes não podem editar campos clínicos restritos',
        );
      }
    }
  }

  private async createEvent(
    clinicId: string,
    clinicalRecordId: string,
    userId: string,
    eventType: string,
    previousStatus: ClinicalRecordStatus | null,
    nextStatus: ClinicalRecordStatus,
  ) {
    await this.prisma.clinicalRecordEvent.create({
      data: {
        clinicId,
        clinicalRecordId,
        eventType,
        previousStatus: previousStatus ?? undefined,
        nextStatus,
        createdByUserId: userId,
      },
    });
  }
}
