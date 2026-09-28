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
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AccessPolicyService } from '../../common/services/access-policy.service';
import { AuthUser } from '../../common/types/auth-user.type';
import { AdminCreateUserDto } from './dto/admin-create-user.dto';
import { AdminUpdateUserDto } from './dto/admin-update-user.dto';
import { UpdatePasswordDto } from './dto/update-password.dto';
import { UsersService } from './users.service';

@Controller('admin/users')
@Roles('ADMIN')
export class AdminUsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  @Get('clinics')
  listClinics(@CurrentUser() user: AuthUser) {
    this.accessPolicy.assertPlatformAdmin(user);
    return this.usersService.adminListClinics();
  }

  @Get('clinics/health')
  getClinicsHealth(@CurrentUser() user: AuthUser) {
    this.accessPolicy.assertPlatformAdmin(user);
    return this.usersService.adminGetClinicsHealth();
  }

  @Get()
  findAll(
    @CurrentUser() user: AuthUser,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    this.accessPolicy.assertPlatformAdmin(user);
    return this.usersService.adminFindAll(
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
    );
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') userId: string) {
    this.accessPolicy.assertPlatformAdmin(user);
    return this.usersService.adminFindById(userId);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: AdminCreateUserDto) {
    this.accessPolicy.assertPlatformAdmin(user);
    return this.usersService.adminCreate(dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') userId: string,
    @Body() dto: AdminUpdateUserDto,
  ) {
    this.accessPolicy.assertPlatformAdmin(user);
    return this.usersService.adminUpdate(userId, dto, user.id);
  }

  @Patch(':id/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  updatePassword(
    @CurrentUser() user: AuthUser,
    @Param('id') userId: string,
    @Body() dto: UpdatePasswordDto,
  ) {
    this.accessPolicy.assertPlatformAdmin(user);
    return this.usersService.adminUpdatePassword(userId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: AuthUser, @Param('id') userId: string) {
    this.accessPolicy.assertPlatformAdmin(user);
    return this.usersService.adminDelete(userId, user.id);
  }
}
