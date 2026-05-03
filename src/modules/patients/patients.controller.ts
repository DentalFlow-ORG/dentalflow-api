import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantScoped } from '../../common/decorators/tenant-scoped.decorator';
import { AccessPolicyService } from '../../common/services/access-policy.service';
import { AuthUser } from '../../common/types/auth-user.type';
import { PatientsService } from './patients.service';

@Controller('patients')
@TenantScoped()
@Roles('OWNER', 'DENTIST', 'ASSISTANT')
export class PatientsController {
  constructor(
    private readonly patientsService: PatientsService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('search') search?: string,
  ) {
    const clinicId = this.accessPolicy.assertClinicMember(user);
    return this.patientsService.listPatients(clinicId, search);
  }

  @Get('history')
  getHistory(
    @CurrentUser() user: AuthUser,
    @Query('identifier') identifier: string,
  ) {
    const clinicId = this.accessPolicy.assertClinicMember(user);
    return this.patientsService.getPatientHistory(clinicId, identifier);
  }
}
