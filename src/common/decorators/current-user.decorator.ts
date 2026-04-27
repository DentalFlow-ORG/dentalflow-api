import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedRequest } from '../types/authenticated-request.type';
import { AuthUser } from '../types/auth-user.type';

export const CurrentUser = createParamDecorator(
  (
    field: keyof AuthUser | undefined,
    ctx: ExecutionContext,
  ): AuthUser | AuthUser[keyof AuthUser] => {
    const user = ctx.switchToHttp().getRequest<AuthenticatedRequest>().user;
    return field ? user[field] : user;
  },
);
