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
import { NotificationService } from './notification.service';
import { SendNotificationDto } from './dto/send-notification.dto';
import {
  CreateConsentDto,
  ListConsentsDto,
} from './dto/notification-consent.dto';
import { UpdatePreferenceDto } from './dto/notification-preference.dto';
import { ListMessagesDto } from './dto/list-messages.dto';

@Controller('notifications')
@TenantScoped()
@RequiresBillingAccess()
export class NotificationController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  // ─── Preferences (OWNER only) ───────────────────────────────────────────────

  @Get('preferences')
  @Roles('OWNER', 'ASSISTANT')
  getPreferences(@CurrentUser() user: AuthUser) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.notifications.getPreferences(clinicId);
  }

  @Patch('preferences')
  @Roles('OWNER')
  updatePreferences(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdatePreferenceDto,
  ) {
    const clinicId = this.accessPolicy.assertOwnerAccess(user);
    return this.notifications.updatePreferences(clinicId, dto);
  }

  // ─── Quota ─────────────────────────────────────────────────────────────────

  @Get('quota')
  @Roles('OWNER', 'ASSISTANT')
  getQuota(@CurrentUser() user: AuthUser) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.notifications.getQuota(clinicId);
  }

  // ─── Templates ─────────────────────────────────────────────────────────────

  @Get('templates')
  @Roles('OWNER', 'ASSISTANT')
  listTemplates(@CurrentUser() _user: AuthUser) {
    return this.notifications.listTemplates();
  }

  // ─── Messages ──────────────────────────────────────────────────────────────

  @Get('messages')
  @Roles('OWNER', 'ASSISTANT')
  listMessages(@CurrentUser() user: AuthUser, @Query() dto: ListMessagesDto) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.notifications.listMessages(clinicId, dto);
  }

  // ─── Consents ──────────────────────────────────────────────────────────────

  @Get('consents')
  @Roles('OWNER', 'ASSISTANT')
  listConsents(@CurrentUser() user: AuthUser, @Query() dto: ListConsentsDto) {
    const clinicId = this.accessPolicy.assertClinicOperationsAccess(user);
    return this.notifications.listConsents(clinicId, dto);
  }

  @Post('consents')
  @HttpCode(HttpStatus.OK)
  @Roles('OWNER', 'ASSISTANT')
  createOrUpdateConsent(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateConsentDto,
  ) {
    const clinicId = this.accessPolicy.assertOwnerOrAssistantAccess(user);
    return this.notifications.createOrUpdateConsent(clinicId, user.id, dto);
  }

  @Patch('consents/:id/revoke')
  @Roles('OWNER', 'ASSISTANT')
  revokeConsent(@CurrentUser() user: AuthUser, @Param('id') consentId: string) {
    const clinicId = this.accessPolicy.assertOwnerOrAssistantAccess(user);
    return this.notifications.revokeConsent(clinicId, consentId, user.id);
  }

  // ─── Send ──────────────────────────────────────────────────────────────────

  @Post('send')
  @HttpCode(HttpStatus.OK)
  @Roles('OWNER', 'ASSISTANT')
  send(@CurrentUser() user: AuthUser, @Body() dto: SendNotificationDto) {
    const clinicId = this.accessPolicy.assertOwnerOrAssistantAccess(user);
    return this.notifications.send(clinicId, user.id, dto);
  }
}
