import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantScoped } from '../../common/decorators/tenant-scoped.decorator';
import { AccessPolicyService } from '../../common/services/access-policy.service';
import { AuthUser } from '../../common/types/auth-user.type';
import { AppointmentsService } from './appointments.service';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { UpdateAppointmentDto } from './dto/update-appointment.dto';
import { UpdateAppointmentStatusDto } from './dto/update-appointment-status.dto';

@Controller('appointments')
@TenantScoped()
export class AppointmentsController {
  constructor(
    private readonly appointmentsService: AppointmentsService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  @Get()
  @Roles('OWNER', 'DENTIST', 'ASSISTANT')
  list(@CurrentUser() user: AuthUser) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.appointmentsService.listAppointments(
      clinicId,
      user.id,
      user.role,
    );
  }

  @Post()
  @Roles('OWNER', 'ASSISTANT')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateAppointmentDto) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.appointmentsService.createAppointment(clinicId, dto);
  }

  @Get(':id')
  @Roles('OWNER', 'DENTIST', 'ASSISTANT')
  findById(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.appointmentsService.findAppointmentById(
      clinicId,
      user.id,
      user.role,
      id,
    );
  }

  @Patch(':id')
  @Roles('OWNER', 'ASSISTANT')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateAppointmentDto,
  ) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.appointmentsService.updateAppointment(clinicId, id, dto);
  }

  @Patch(':id/status')
  @Roles('OWNER', 'ASSISTANT')
  updateStatus(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateAppointmentStatusDto,
  ) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.appointmentsService.updateAppointmentStatus(clinicId, id, dto);
  }

  @Post(':id/cancel')
  @Roles('OWNER', 'ASSISTANT')
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: Pick<UpdateAppointmentStatusDto, 'canceledBy' | 'cancellationReason'>,
  ) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.appointmentsService.cancelAppointment(clinicId, id, dto);
  }
}
