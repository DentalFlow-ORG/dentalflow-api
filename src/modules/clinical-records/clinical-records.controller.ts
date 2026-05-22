import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequiresBillingAccess } from '../../common/decorators/requires-billing-access.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantScoped } from '../../common/decorators/tenant-scoped.decorator';
import { AccessPolicyService } from '../../common/services/access-policy.service';
import { AuthUser } from '../../common/types/auth-user.type';
import { ClinicalRecordsService } from './clinical-records.service';
import { CreateClinicalRecordDto } from './dto/create-clinical-record.dto';
import { UpdateClinicalRecordDto } from './dto/update-clinical-record.dto';
import { CreateClinicalTemplateDto } from './dto/create-clinical-template.dto';
import { UpdateClinicalTemplateDto } from './dto/update-clinical-template.dto';
import {
  ClinicalIdentifierQueryDto,
  ListClinicalRecordsQueryDto,
} from './dto/clinical-record-query.dto';
import { UpsertOdontogramDto } from './dto/odontogram.dto';
import {
  AddClinicalAttachmentDto,
  UpdateClinicalAttachmentDescriptionDto,
} from './dto/clinical-attachment.dto';

@Controller('clinical-records')
@TenantScoped()
@RequiresBillingAccess()
export class ClinicalRecordsController {
  constructor(
    private readonly clinicalRecordsService: ClinicalRecordsService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  // ----------------------------------------------------------------
  // Records
  // ----------------------------------------------------------------

  @Get()
  @Roles('OWNER', 'DENTIST')
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListClinicalRecordsQueryDto,
  ) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.clinicalRecordsService.listRecords(
      clinicId,
      user.id,
      user.role,
      {
        status: query.status,
        dentistProfileId: query.dentistProfileId,
      },
    );
  }

  @Post()
  @Roles('OWNER', 'DENTIST')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateClinicalRecordDto) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.clinicalRecordsService.createRecord(
      clinicId,
      user.id,
      user.role,
      dto,
    );
  }

  @Get('by-appointment/:appointmentId')
  @Roles('OWNER', 'DENTIST')
  findByAppointment(
    @CurrentUser() user: AuthUser,
    @Param('appointmentId') appointmentId: string,
  ) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.clinicalRecordsService.findByAppointmentId(
      clinicId,
      user.id,
      user.role,
      appointmentId,
    );
  }

  @Get('patient-timeline')
  @Roles('OWNER', 'DENTIST')
  patientTimeline(
    @CurrentUser() user: AuthUser,
    @Query() query: ClinicalIdentifierQueryDto,
  ) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.clinicalRecordsService.getPatientTimeline(
      clinicId,
      user.id,
      user.role,
      query.identifier,
    );
  }

  // ----------------------------------------------------------------
  // Odontogram (must be before :id to avoid route collision)
  // ----------------------------------------------------------------

  @Get('odontogram')
  @Roles('OWNER', 'DENTIST')
  getOdontogram(
    @CurrentUser() user: AuthUser,
    @Query() query: ClinicalIdentifierQueryDto,
  ) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.clinicalRecordsService.getOdontogram(
      clinicId,
      user.id,
      user.role,
      query.identifier,
    );
  }

  @Post('odontogram')
  @Roles('OWNER', 'DENTIST')
  upsertOdontogram(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpsertOdontogramDto,
  ) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.clinicalRecordsService.upsertOdontogram(
      clinicId,
      user.id,
      user.role,
      dto.identifier,
      dto.patientName,
      dto.data,
    );
  }

  @Get(':id')
  @Roles('OWNER', 'DENTIST')
  findById(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.clinicalRecordsService.findRecordById(
      clinicId,
      user.id,
      user.role,
      id,
    );
  }

  @Patch(':id')
  @Roles('OWNER', 'DENTIST')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateClinicalRecordDto,
  ) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.clinicalRecordsService.updateRecord(
      clinicId,
      user.id,
      user.role,
      id,
      dto,
    );
  }

  @Post(':id/complete')
  @Roles('OWNER', 'DENTIST')
  @HttpCode(HttpStatus.OK)
  complete(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.clinicalRecordsService.completeRecord(
      clinicId,
      user.id,
      user.role,
      id,
    );
  }

  @Post(':id/lock')
  @Roles('OWNER', 'DENTIST')
  @HttpCode(HttpStatus.OK)
  lock(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.clinicalRecordsService.lockRecord(
      clinicId,
      user.id,
      user.role,
      id,
    );
  }

  @Post(':id/cancel')
  @Roles('OWNER', 'DENTIST')
  @HttpCode(HttpStatus.OK)
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.clinicalRecordsService.cancelRecord(
      clinicId,
      user.id,
      user.role,
      id,
    );
  }

  @Post(':id/restore')
  @Roles('OWNER', 'DENTIST')
  @HttpCode(HttpStatus.OK)
  restore(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.clinicalRecordsService.restoreRecord(
      clinicId,
      user.id,
      user.role,
      id,
    );
  }

  @Get(':id/print-data')
  @Roles('OWNER', 'DENTIST')
  getPrintData(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.clinicalRecordsService.getPrintData(
      clinicId,
      user.id,
      user.role,
      id,
    );
  }

  // ----------------------------------------------------------------
  // Attachments
  // ----------------------------------------------------------------

  @Get(':id/attachments')
  @Roles('OWNER', 'DENTIST')
  listAttachments(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.clinicalRecordsService.listAttachments(
      clinicId,
      user.id,
      user.role,
      id,
    );
  }

  @Post(':id/attachments')
  @Roles('OWNER', 'DENTIST')
  addAttachment(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: AddClinicalAttachmentDto,
  ) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.clinicalRecordsService.addAttachmentMetadata(
      clinicId,
      user.id,
      user.role,
      id,
      dto,
    );
  }

  @Patch(':id/attachments/:attachmentId')
  @Roles('OWNER', 'DENTIST')
  updateAttachmentDescription(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @Body() dto: UpdateClinicalAttachmentDescriptionDto,
  ) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.clinicalRecordsService.updateAttachmentDescription(
      clinicId,
      user.id,
      user.role,
      id,
      attachmentId,
      dto.description ?? '',
    );
  }

  @Delete(':id/attachments/:attachmentId')
  @Roles('OWNER', 'DENTIST')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeAttachment(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.clinicalRecordsService.removeAttachment(
      clinicId,
      user.id,
      user.role,
      id,
      attachmentId,
    );
  }

  // ----------------------------------------------------------------
  // Templates
  // ----------------------------------------------------------------

  @Get('templates/list')
  @Roles('OWNER', 'DENTIST')
  listTemplates(@CurrentUser() user: AuthUser) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.clinicalRecordsService.listTemplates(clinicId);
  }

  @Post('templates')
  @Roles('OWNER', 'DENTIST')
  createTemplate(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateClinicalTemplateDto,
  ) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.clinicalRecordsService.createTemplate(clinicId, user.id, dto);
  }

  @Patch('templates/:templateId')
  @Roles('OWNER', 'DENTIST')
  updateTemplate(
    @CurrentUser() user: AuthUser,
    @Param('templateId') templateId: string,
    @Body() dto: UpdateClinicalTemplateDto,
  ) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.clinicalRecordsService.updateTemplate(
      clinicId,
      templateId,
      dto,
    );
  }

  @Delete('templates/:templateId')
  @Roles('OWNER', 'DENTIST')
  @HttpCode(HttpStatus.OK)
  deactivateTemplate(
    @CurrentUser() user: AuthUser,
    @Param('templateId') templateId: string,
  ) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.clinicalRecordsService.deactivateTemplate(clinicId, templateId);
  }
}
