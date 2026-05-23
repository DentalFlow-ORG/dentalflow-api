import { Controller, Get, Query } from '@nestjs/common';
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
} from './dto/patient-query.dto';

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
