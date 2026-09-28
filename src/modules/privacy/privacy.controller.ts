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
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';

import { AnyAuthenticated } from '../../common/decorators/any-authenticated.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthUser } from '../../common/types/auth-user.type';
import { CreatePrivacyRequestDto } from './dto/create-privacy-request.dto';
import { ListCookieConsentsDto } from './dto/list-cookie-consents.dto';
import { ListPrivacyRequestsDto } from './dto/list-privacy-requests.dto';
import { UpdatePrivacyRequestStatusDto } from './dto/update-privacy-request-status.dto';
import { LogCookieConsentDto } from './dto/log-cookie-consent.dto';
import { PrivacyService } from './privacy.service';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { trimValue } from '../../common/utils/transform.helpers';

class RespondDto {
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @IsNotEmpty()
  // Same column and limit as UpdatePrivacyRequestStatusDto.responseNotes.
  @MaxLength(2000)
  responseNotes!: string;
}

function extractMeta(req: Request) {
  const rawUA = req.headers['user-agent'];
  return {
    ipAddress: req.ip,
    userAgent: typeof rawUA === 'string' ? rawUA : undefined,
  };
}

@Controller('privacy')
export class PrivacyController {
  constructor(private readonly privacyService: PrivacyService) {}

  // ── Public endpoints ──────────────────────────────────────────────────────

  @Public()
  @Post('requests')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60_000 * 60, limit: 5 } }) // 5 requests per hour per IP
  createRequest(@Body() dto: CreatePrivacyRequestDto, @Req() req: Request) {
    return this.privacyService.createRequest(dto, extractMeta(req));
  }

  @Public()
  @Post('cookie-consent')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async logCookieConsent(
    @Body() dto: LogCookieConsentDto,
    @Req() req: Request,
    // User may or may not be authenticated when this is called
  ) {
    await this.privacyService.logCookieConsent(dto, extractMeta(req));
  }

  // ── Protected endpoints ───────────────────────────────────────────────────

  // OWNER access disabled until PrivacyRequest gains a trusted clinicId FK.
  // See: privacy.service.ts listRequests() for context.
  @Roles('ADMIN')
  @Get('requests')
  listRequests(
    @CurrentUser() user: AuthUser,
    @Query() dto: ListPrivacyRequestsDto,
  ) {
    return this.privacyService.listRequests(user, dto);
  }

  @Roles('ADMIN')
  @Get('cookie-consents')
  listCookieConsents(@Query() dto: ListCookieConsentsDto) {
    return this.privacyService.listCookieConsents(dto);
  }

  @Roles('ADMIN')
  @Get('requests/:id')
  getRequest(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.privacyService.getRequest(id, user);
  }

  @Roles('ADMIN')
  @Patch('requests/:id/status')
  @HttpCode(HttpStatus.OK)
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdatePrivacyRequestStatusDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.privacyService.updateStatus(id, dto, user, extractMeta(req));
  }

  @Roles('ADMIN')
  @Post('requests/:id/response')
  @HttpCode(HttpStatus.OK)
  respondToRequest(
    @Param('id') id: string,
    @Body() dto: RespondDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.privacyService.respondToRequest(
      id,
      dto.responseNotes,
      user,
      extractMeta(req),
    );
  }

  // ── Authenticated cookie consent (with userId) ───────────────────────────

  @AnyAuthenticated()
  @Post('cookie-consent/authenticated')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async logAuthenticatedCookieConsent(
    @Body() dto: LogCookieConsentDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    await this.privacyService.logCookieConsent(dto, {
      ...extractMeta(req),
      userId: user.id,
    });
  }
}
