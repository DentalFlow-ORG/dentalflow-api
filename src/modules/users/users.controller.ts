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
import { Roles } from '../../common/decorators/roles.decorator';
import { AccessPolicyService } from '../../common/services/access-policy.service';
import { AuthUser } from '../../common/types/auth-user.type';
import { CreateMemberDto } from './dto/create-member.dto';
import { UpdatePasswordDto } from './dto/update-password.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  // ─── Current user ────────────────────────────────────────────────────────────

  @AnyAuthenticated()
  @Get('me')
  getMe(@CurrentUser() user: AuthUser) {
    return this.usersService.findById(user.id);
  }

  // ─── OWNER: clinic member management ─────────────────────────────────────────

  @Get()
  @Roles('OWNER')
  findMembers(@CurrentUser() user: AuthUser) {
    return this.usersService.findClinicMembers(
      this.accessPolicy.assertOwnerAccess(user),
    );
  }

  @Post()
  @Roles('OWNER')
  createMember(@CurrentUser() user: AuthUser, @Body() dto: CreateMemberDto) {
    return this.usersService.createMember(
      this.accessPolicy.assertOwnerAccess(user),
      dto,
    );
  }

  @Patch(':id')
  @Roles('OWNER')
  updateMember(
    @CurrentUser() user: AuthUser,
    @Param('id') userId: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.usersService.updateMember(
      this.accessPolicy.assertOwnerAccess(user),
      userId,
      dto,
    );
  }

  @Patch(':id/password')
  @Roles('OWNER')
  @HttpCode(HttpStatus.NO_CONTENT)
  updateMemberPassword(
    @CurrentUser() user: AuthUser,
    @Param('id') userId: string,
    @Body() dto: UpdatePasswordDto,
  ) {
    return this.usersService.updateMemberPassword(
      this.accessPolicy.assertOwnerAccess(user),
      userId,
      dto,
    );
  }

  @Delete(':id')
  @Roles('OWNER')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteMember(
    @CurrentUser() user: AuthUser,
    @Param('id') userId: string,
  ) {
    return this.usersService.deleteMember(
      this.accessPolicy.assertOwnerAccess(user),
      userId,
    );
  }

  // ─── Legacy aliases (kept for backward compatibility) ────────────────────────

  @Get('clinic/members')
  @Roles('OWNER')
  findClinicMembers(@CurrentUser() user: AuthUser) {
    return this.usersService.findClinicMembers(
      this.accessPolicy.assertOwnerAccess(user),
    );
  }

  @Post('clinic/members')
  @Roles('OWNER')
  createClinicMember(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateMemberDto,
  ) {
    return this.usersService.createMember(
      this.accessPolicy.assertOwnerAccess(user),
      dto,
    );
  }

  // ─── ADMIN stub ──────────────────────────────────────────────────────────────

  @Get('admin-only')
  @Roles('ADMIN')
  adminOnly(@CurrentUser() user: AuthUser) {
    this.accessPolicy.assertPlatformAdmin(user);
    return { message: 'Authorized', role: user.role };
  }
}
