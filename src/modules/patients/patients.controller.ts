import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequiresBillingAccess } from '../../common/decorators/requires-billing-access.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantScoped } from '../../common/decorators/tenant-scoped.decorator';
import { AccessPolicyService } from '../../common/services/access-policy.service';
import { AuthUser } from '../../common/types/auth-user.type';
import { PatientsService } from './patients.service';
import {
  ListPatientsQueryDto,
  PatientHistoryQueryDto,
  PatientAvatarQueryDto,
} from './dto/patient-query.dto';
import { UpsertPatientAvatarDto } from './dto/upsert-patient-avatar.dto';
import { BatchPatientAvatarsDto } from './dto/batch-patient-avatars.dto';

@Controller('patients')
@TenantScoped()
@Roles('OWNER', 'ASSISTANT')
@RequiresBillingAccess()
export class PatientsController {
  constructor(
    private readonly patientsService: PatientsService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: ListPatientsQueryDto) {
    const clinicId = this.accessPolicy.assertClinicMember(user);
    return this.patientsService.listPatients(clinicId, query.search);
  }

  @Get('avatar')
  getAvatar(
    @CurrentUser() user: AuthUser,
    @Query() query: PatientAvatarQueryDto,
  ) {
    const clinicId = this.accessPolicy.assertClinicMember(user);
    return this.patientsService.getPatientAvatar(clinicId, query.identifier);
  }

  @Post('avatars/batch')
  batchGetAvatars(
    @CurrentUser() user: AuthUser,
    @Body() dto: BatchPatientAvatarsDto,
  ) {
    const clinicId = this.accessPolicy.assertClinicMember(user);
    return this.patientsService.batchGetPatientAvatars(clinicId, dto.identifiers);
  }

  @Put('avatar')
  upsertAvatar(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpsertPatientAvatarDto,
  ) {
    const clinicId = this.accessPolicy.assertClinicMember(user);
    return this.patientsService.upsertPatientAvatar(
      clinicId,
      dto.identifier,
      dto.avatarBase64,
    );
  }

  @Get('attention')
  getAttention(@CurrentUser() user: AuthUser) {
    const clinicId = this.accessPolicy.assertClinicMember(user);
    return this.patientsService.getPatientsAttention(clinicId);
  }

  @Get('history')
  getHistory(
    @CurrentUser() user: AuthUser,
    @Query() query: PatientHistoryQueryDto,
  ) {
    const clinicId = this.accessPolicy.assertClinicMember(user);
    return this.patientsService.getPatientHistory(clinicId, query.identifier);
  }
}
