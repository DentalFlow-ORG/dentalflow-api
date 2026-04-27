import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AccessPolicyService } from '../../common/services/access-policy.service';
import { AuthUser } from '../../common/types/auth-user.type';
import { CreateMemberDto } from './dto/create-member.dto';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  @Get('me')
  getMe(@CurrentUser() user: AuthUser) {
    return this.usersService.findById(user.id);
  }

  @Get('clinic/members')
  @Roles('OWNER')
  findClinicMembers(@CurrentUser() user: AuthUser) {
    return this.usersService.findClinicMembers(
      this.accessPolicy.assertOwnerAccess(user),
    );
  }

  @Post('clinic/members')
  @Roles('OWNER')
  createMember(@CurrentUser() user: AuthUser, @Body() dto: CreateMemberDto) {
    return this.usersService.createMember(
      this.accessPolicy.assertOwnerAccess(user),
      dto,
    );
  }

  @Get('admin-only')
  @Roles('ADMIN')
  adminOnly(@CurrentUser() user: AuthUser) {
    this.accessPolicy.assertPlatformAdmin(user);
    return { message: 'Authorized', role: user.role };
  }
}
