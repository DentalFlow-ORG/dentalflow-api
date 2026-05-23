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
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequiresBillingAccess } from '../../common/decorators/requires-billing-access.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantScoped } from '../../common/decorators/tenant-scoped.decorator';
import { AccessPolicyService } from '../../common/services/access-policy.service';
import { AuthUser } from '../../common/types/auth-user.type';
import { AppointmentsService } from './appointments.service';
import { CreateAvailabilityDto } from './dto/create-availability.dto';
import { CreateAvailabilityExceptionDto } from './dto/create-availability-exception.dto';
import { UpdateAvailabilityDto } from './dto/update-availability.dto';
import { UpdateAvailabilityExceptionDto } from './dto/update-availability-exception.dto';
import {
  AvailabilityExceptionParamDto,
  AvailabilityParamDto,
  ProfileParamDto,
} from './dto/appointment-param.dto';

@Controller('profiles/:profileId')
@TenantScoped()
@RequiresBillingAccess()
export class AvailabilityController {
  constructor(
    private readonly appointmentsService: AppointmentsService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  @Get('availability')
  @Roles('OWNER', 'DENTIST', 'ASSISTANT')
  listAvailability(
    @CurrentUser() user: AuthUser,
    @Param() params: ProfileParamDto,
  ) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.appointmentsService.listAvailability(
      clinicId,
      user.id,
      user.role,
      params.profileId,
    );
  }

  @Post('availability')
  @Roles('OWNER', 'DENTIST')
  createAvailability(
    @CurrentUser() user: AuthUser,
    @Param() params: ProfileParamDto,
    @Body() dto: CreateAvailabilityDto,
  ) {
    const clinicId = this.accessPolicy.assertClinicMember(user);
    return this.appointmentsService.createAvailability(
      clinicId,
      user.id,
      user.role,
      params.profileId,
      dto,
    );
  }

  @Patch('availability/:availabilityId')
  @Roles('OWNER', 'DENTIST')
  updateAvailability(
    @CurrentUser() user: AuthUser,
    @Param() params: AvailabilityParamDto,
    @Body() dto: UpdateAvailabilityDto,
  ) {
    const clinicId = this.accessPolicy.assertClinicMember(user);
    return this.appointmentsService.updateAvailability(
      clinicId,
      user.id,
      user.role,
      params.profileId,
      params.availabilityId,
      dto,
    );
  }

  @Delete('availability/:availabilityId')
  @Roles('OWNER', 'DENTIST')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeAvailability(
    @CurrentUser() user: AuthUser,
    @Param() params: AvailabilityParamDto,
  ) {
    const clinicId = this.accessPolicy.assertClinicMember(user);
    return this.appointmentsService.removeAvailability(
      clinicId,
      user.id,
      user.role,
      params.profileId,
      params.availabilityId,
    );
  }

  @Get('availability-exceptions')
  @Roles('OWNER', 'DENTIST', 'ASSISTANT')
  listAvailabilityExceptions(
    @CurrentUser() user: AuthUser,
    @Param() params: ProfileParamDto,
  ) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.appointmentsService.listAvailabilityExceptions(
      clinicId,
      user.id,
      user.role,
      params.profileId,
    );
  }

  @Post('availability-exceptions')
  @Roles('OWNER', 'DENTIST')
  createAvailabilityException(
    @CurrentUser() user: AuthUser,
    @Param() params: ProfileParamDto,
    @Body() dto: CreateAvailabilityExceptionDto,
  ) {
    const clinicId = this.accessPolicy.assertClinicMember(user);
    return this.appointmentsService.createAvailabilityException(
      clinicId,
      user.id,
      user.role,
      params.profileId,
      dto,
    );
  }

  @Patch('availability-exceptions/:exceptionId')
  @Roles('OWNER', 'DENTIST')
  updateAvailabilityException(
    @CurrentUser() user: AuthUser,
    @Param() params: AvailabilityExceptionParamDto,
    @Body() dto: UpdateAvailabilityExceptionDto,
  ) {
    const clinicId = this.accessPolicy.assertClinicMember(user);
    return this.appointmentsService.updateAvailabilityException(
      clinicId,
      user.id,
      user.role,
      params.profileId,
      params.exceptionId,
      dto,
    );
  }

  @Delete('availability-exceptions/:exceptionId')
  @Roles('OWNER', 'DENTIST')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeAvailabilityException(
    @CurrentUser() user: AuthUser,
    @Param() params: AvailabilityExceptionParamDto,
  ) {
    const clinicId = this.accessPolicy.assertClinicMember(user);
    return this.appointmentsService.removeAvailabilityException(
      clinicId,
      user.id,
      user.role,
      params.profileId,
      params.exceptionId,
    );
  }
}
