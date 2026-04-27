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
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthUser } from '../../common/types/auth-user.type';
import { CreateProfileDto } from './dto/create-profile.dto';
import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateServiceDto } from './dto/update-service.dto';
import { ProfilesService } from './profiles.service';

@Controller('profiles')
export class ProfilesController {
  constructor(private readonly profilesService: ProfilesService) {}

  @Post()
  @Roles('OWNER', 'ADMIN')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateProfileDto) {
    return this.profilesService.create(user.clinicId, dto);
  }

  @Get()
  findAll(@CurrentUser() user: AuthUser) {
    return this.profilesService.findAll(user.clinicId);
  }

  // Must be declared before :id to avoid route shadowing
  @Public()
  @Get('p/:slug')
  findBySlug(@Param('slug') slug: string) {
    return this.profilesService.findBySlug(slug);
  }

  @Get(':id')
  findById(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.profilesService.findById(user.clinicId, id);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN', 'DENTIST')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.profilesService.update(
      user.clinicId,
      user.id,
      user.role,
      id,
      dto,
    );
  }

  @Patch(':id/publish')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  togglePublish(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.profilesService.togglePublish(user.clinicId, id);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.profilesService.remove(user.clinicId, id);
  }

  @Post(':id/services')
  @Roles('OWNER', 'ADMIN')
  createService(
    @CurrentUser() user: AuthUser,
    @Param('id') profileId: string,
    @Body() dto: CreateServiceDto,
  ) {
    return this.profilesService.createService(user.clinicId, profileId, dto);
  }

  @Patch(':id/services/:serviceId')
  @Roles('OWNER', 'ADMIN')
  updateService(
    @CurrentUser() user: AuthUser,
    @Param('id') profileId: string,
    @Param('serviceId') serviceId: string,
    @Body() dto: UpdateServiceDto,
  ) {
    return this.profilesService.updateService(
      user.clinicId,
      profileId,
      serviceId,
      dto,
    );
  }

  @Delete(':id/services/:serviceId')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeService(
    @CurrentUser() user: AuthUser,
    @Param('id') profileId: string,
    @Param('serviceId') serviceId: string,
  ) {
    return this.profilesService.removeService(
      user.clinicId,
      profileId,
      serviceId,
    );
  }
}
