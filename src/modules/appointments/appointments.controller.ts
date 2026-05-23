import {
  Body,
  Controller,
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
import { AppointmentsService } from './appointments.service';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { UpdateAppointmentDto } from './dto/update-appointment.dto';
import { UpdateAppointmentPaymentDto } from './dto/update-appointment-payment.dto';
import { CancelAppointmentDto } from './dto/cancel-appointment.dto';
import { UpdateAppointmentStatusDto } from './dto/update-appointment-status.dto';
import { GetAvailableSlotsDto } from './dto/get-available-slots.dto';
import { ListAppointmentsQueryDto } from './dto/appointment-query.dto';
import { AppointmentIdParamDto } from './dto/appointment-param.dto';

@Controller('appointments')
@TenantScoped()
@RequiresBillingAccess()
export class AppointmentsController {
  constructor(
    private readonly appointmentsService: AppointmentsService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  @Get()
  @Roles('OWNER', 'DENTIST', 'ASSISTANT')
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListAppointmentsQueryDto,
  ) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.appointmentsService.listAppointments(
      clinicId,
      user.id,
      user.role,
      query.date,
    );
  }

  @Post()
  @Roles('OWNER', 'ASSISTANT')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateAppointmentDto) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.appointmentsService.createAppointment(
      clinicId,
      user.id,
      user.role,
      dto,
    );
  }

  @Get('slots')
  @Roles('OWNER', 'DENTIST', 'ASSISTANT')
  getAvailableSlots(
    @CurrentUser() user: AuthUser,
    @Query() dto: GetAvailableSlotsDto,
  ) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.appointmentsService.getAvailableSlots(clinicId, dto);
  }

  @Get(':id')
  @Roles('OWNER', 'DENTIST', 'ASSISTANT')
  findById(@CurrentUser() user: AuthUser, @Param() params: AppointmentIdParamDto) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.appointmentsService.findAppointmentById(
      clinicId,
      user.id,
      user.role,
      params.id,
    );
  }

  @Patch(':id')
  @Roles('OWNER', 'ASSISTANT')
  update(
    @CurrentUser() user: AuthUser,
    @Param() params: AppointmentIdParamDto,
    @Body() dto: UpdateAppointmentDto,
  ) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.appointmentsService.updateAppointment(
      clinicId,
      user.id,
      user.role,
      params.id,
      dto,
    );
  }

  @Patch(':id/status')
  @Roles('OWNER', 'DENTIST', 'ASSISTANT')
  updateStatus(
    @CurrentUser() user: AuthUser,
    @Param() params: AppointmentIdParamDto,
    @Body() dto: UpdateAppointmentStatusDto,
  ) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.appointmentsService.updateAppointmentStatus(
      clinicId,
      user.id,
      user.role,
      params.id,
      dto,
    );
  }

  @Post(':id/cancel')
  @Roles('OWNER', 'ASSISTANT')
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentUser() user: AuthUser,
    @Param() params: AppointmentIdParamDto,
    @Body() dto: CancelAppointmentDto,
  ) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.appointmentsService.cancelAppointment(
      clinicId,
      user.id,
      user.role,
      params.id,
      dto,
    );
  }

  @Patch(':id/confirm')
  @Roles('OWNER', 'ASSISTANT')
  confirmAction(@CurrentUser() user: AuthUser, @Param() params: AppointmentIdParamDto) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.appointmentsService.updateAppointmentStatus(
      clinicId,
      user.id,
      user.role,
      params.id,
      { status: 'CONFIRMED' },
    );
  }

  @Patch(':id/cancel')
  @Roles('OWNER', 'ASSISTANT')
  cancelAction(
    @CurrentUser() user: AuthUser,
    @Param() params: AppointmentIdParamDto,
    @Body() dto: CancelAppointmentDto,
  ) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.appointmentsService.cancelAppointment(
      clinicId,
      user.id,
      user.role,
      params.id,
      { cancellationReason: dto.cancellationReason, canceledBy: 'CLINIC' },
    );
  }

  @Patch(':id/complete')
  @Roles('OWNER', 'DENTIST', 'ASSISTANT')
  completeAction(@CurrentUser() user: AuthUser, @Param() params: AppointmentIdParamDto) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.appointmentsService.updateAppointmentStatus(
      clinicId,
      user.id,
      user.role,
      params.id,
      { status: 'COMPLETED' },
    );
  }

  @Patch(':id/no-show')
  @Roles('OWNER', 'DENTIST', 'ASSISTANT')
  noShowAction(@CurrentUser() user: AuthUser, @Param() params: AppointmentIdParamDto) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.appointmentsService.updateAppointmentStatus(
      clinicId,
      user.id,
      user.role,
      params.id,
      { status: 'NO_SHOW' },
    );
  }

  @Patch(':id/payment')
  @Roles('OWNER', 'ASSISTANT')
  updatePayment(
    @CurrentUser() user: AuthUser,
    @Param() params: AppointmentIdParamDto,
    @Body() dto: UpdateAppointmentPaymentDto,
  ) {
    const clinicId = this.accessPolicy.assertOwnerOrAssistantAccess(user);
    return this.appointmentsService.updateAppointmentPayment(
      clinicId,
      user.id,
      params.id,
      dto,
    );
  }
}
