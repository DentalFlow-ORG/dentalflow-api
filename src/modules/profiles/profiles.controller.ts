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
import { AnyAuthenticated } from '../../common/decorators/any-authenticated.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantScoped } from '../../common/decorators/tenant-scoped.decorator';
import { AccessPolicyService } from '../../common/services/access-policy.service';
import { AuthUser } from '../../common/types/auth-user.type';
import { CreateProfileDto } from './dto/create-profile.dto';
import { CreateServiceDto } from './dto/create-service.dto';
import { SetProfileSpecialtiesDto } from './dto/set-profile-specialties.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateServiceDto } from './dto/update-service.dto';
import { ProfilesService } from './profiles.service';

@Controller('profiles')
@TenantScoped()
export class ProfilesController {
  constructor(
    private readonly profilesService: ProfilesService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  @Post()
  @Roles('OWNER')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateProfileDto) {
    return this.profilesService.create(
      this.accessPolicy.assertOwnerAccess(user),
      dto,
    );
  }

  @AnyAuthenticated()
  @Get()
  findAll(@CurrentUser() user: AuthUser) {
    return this.profilesService.findAll(
      this.accessPolicy.assertClinicMember(user),
    );
  }

  // Must be declared before :id to avoid route shadowing
  @Public()
  @Get('p/:slug')
  findBySlug(@Param('slug') slug: string) {
    return this.profilesService.findBySlug(slug);
  }

  @AnyAuthenticated()
  @Get(':id')
  findById(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.profilesService.findById(
      this.accessPolicy.assertClinicMember(user),
      id,
    );
  }

  @Patch(':id')
  @Roles('OWNER', 'DENTIST')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.profilesService.update(
      this.accessPolicy.assertClinicMember(user),
      user.id,
      user.role,
      id,
      dto,
    );
  }

  @Patch(':id/publish')
  @Roles('OWNER')
  @HttpCode(HttpStatus.OK)
  togglePublish(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.profilesService.togglePublish(
      this.accessPolicy.assertOwnerAccess(user),
      id,
    );
  }

  @Delete(':id')
  @Roles('OWNER')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.profilesService.remove(
      this.accessPolicy.assertOwnerAccess(user),
      id,
    );
  }

  @Post(':id/specialties')
  @Roles('OWNER', 'DENTIST')
  setSpecialties(
    @CurrentUser() user: AuthUser,
    @Param('id') profileId: string,
    @Body() dto: SetProfileSpecialtiesDto,
  ) {
    return this.profilesService.setSpecialties(
      this.accessPolicy.assertClinicMember(user),
      user.id,
      user.role,
      profileId,
      dto.specialtyIds,
    );
  }

  @Post(':id/services')
  @Roles('OWNER')
  createService(
    @CurrentUser() user: AuthUser,
    @Param('id') profileId: string,
    @Body() dto: CreateServiceDto,
  ) {
    return this.profilesService.createService(
      this.accessPolicy.assertOwnerAccess(user),
      profileId,
      dto,
    );
  }

  @Patch(':id/services/:serviceId')
  @Roles('OWNER')
  updateService(
    @CurrentUser() user: AuthUser,
    @Param('id') profileId: string,
    @Param('serviceId') serviceId: string,
    @Body() dto: UpdateServiceDto,
  ) {
    return this.profilesService.updateService(
      this.accessPolicy.assertOwnerAccess(user),
      profileId,
      serviceId,
      dto,
    );
  }

  @Delete(':id/services/:serviceId')
  @Roles('OWNER')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeService(
    @CurrentUser() user: AuthUser,
    @Param('id') profileId: string,
    @Param('serviceId') serviceId: string,
  ) {
    return this.profilesService.removeService(
      this.accessPolicy.assertOwnerAccess(user),
      profileId,
      serviceId,
    );
  }
}
