import { Body, Controller, Get, Patch } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequiresBillingAccess } from '../../common/decorators/requires-billing-access.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantScoped } from '../../common/decorators/tenant-scoped.decorator';
import { AccessPolicyService } from '../../common/services/access-policy.service';
import { AuthUser } from '../../common/types/auth-user.type';
import { ClinicService } from './clinic.service';
import { UpdateClinicProfileDto } from './dto/update-clinic-profile.dto';

@Controller('clinic')
@TenantScoped()
@RequiresBillingAccess()
export class ClinicController {
  constructor(
    private readonly clinicService: ClinicService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  @Get('profile')
  @Roles('OWNER', 'ASSISTANT')
  getProfile(@CurrentUser() user: AuthUser) {
    const clinicId = this.accessPolicy.assertClinicMember(user);
    return this.clinicService.getProfile(clinicId);
  }

  @Patch('profile')
  @Roles('OWNER')
  updateProfile(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateClinicProfileDto,
  ) {
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    return this.clinicService.updateProfile(clinicId, dto);
  }
}
