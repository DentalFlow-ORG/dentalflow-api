import { Controller, Get, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { RequiresBillingAccess } from '../../common/decorators/requires-billing-access.decorator';
import { RequirePlanFeature } from '../../common/decorators/require-plan-feature.decorator';
import { PlanFeature } from '../billing/plan-feature.types';
import { Roles } from '../../common/decorators/roles.decorator';
import { AccessPolicyService } from '../../common/services/access-policy.service';
import { AuthUser } from '../../common/types/auth-user.type';
import { appConfig } from '../../config/app.config';
import { CalendarIntegrationsService } from './calendar-integrations.service';

@Controller('calendar-integrations/google')
@RequiresBillingAccess()
@RequirePlanFeature(PlanFeature.GOOGLE_CALENDAR)
export class CalendarIntegrationsController {
  constructor(
    private readonly integrationsService: CalendarIntegrationsService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  @Get('status')
  @Roles('OWNER', 'DENTIST')
  status(@CurrentUser() user: AuthUser) {
    if (user.role === 'DENTIST') {
      const clinicId = this.accessPolicy.assertClinicMember(user);
      return this.integrationsService.getDentistStatus(user.id, clinicId);
    }
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    return this.integrationsService.getStatus(clinicId);
  }

  @Post('connect')
  @Roles('OWNER', 'DENTIST')
  connect(@CurrentUser() user: AuthUser) {
    if (user.role === 'DENTIST') {
      const clinicId = this.accessPolicy.assertClinicMember(user);
      return this.integrationsService.createDentistConnectUrl(user.id, clinicId);
    }
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    return this.integrationsService.createConnectUrl(clinicId, user.id);
  }

  @Public()
  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() response: Response,
  ) {
    const redirectRole = await this.integrationsService.resolveCallbackRedirectRole(state);
    const redirectPath = redirectRole === 'DENTIST' ? '/app/agenda' : '/app/agendamentos';
    const redirectUrl = new URL(redirectPath, appConfig.frontendOrigin);

    if (error) {
      redirectUrl.searchParams.set('googleCalendar', 'error');
      redirectUrl.searchParams.set(
        'message',
        'Conexão com Google Agenda cancelada.',
      );
      response.redirect(redirectUrl.toString());
      return;
    }

    try {
      await this.integrationsService.handleCallback(code, state);
      redirectUrl.searchParams.set('googleCalendar', 'connected');
    } catch (err) {
      redirectUrl.searchParams.set('googleCalendar', 'error');
      redirectUrl.searchParams.set(
        'message',
        err instanceof Error
          ? err.message
          : 'Não foi possível conectar o Google Agenda.',
      );
    }

    response.redirect(redirectUrl.toString());
  }

  @Post('disconnect')
  @Roles('OWNER', 'DENTIST')
  disconnect(@CurrentUser() user: AuthUser) {
    if (user.role === 'DENTIST') {
      const clinicId = this.accessPolicy.assertClinicMember(user);
      return this.integrationsService.disconnectDentist(user.id, clinicId);
    }
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    return this.integrationsService.disconnect(clinicId);
  }

  @Post('sync')
  @Roles('OWNER', 'DENTIST')
  sync(@CurrentUser() user: AuthUser) {
    if (user.role === 'DENTIST') {
      const clinicId = this.accessPolicy.assertClinicMember(user);
      return this.integrationsService.syncDentist(user.id, clinicId);
    }
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    return this.integrationsService.sync(clinicId);
  }
}
