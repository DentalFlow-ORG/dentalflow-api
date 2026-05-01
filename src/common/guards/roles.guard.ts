import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import {
  IS_ANY_AUTHENTICATED_KEY,
} from '../decorators/any-authenticated.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { AuthenticatedRequest } from '../types/authenticated-request.type';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles?.length) {
      const isAnyAuthenticated = this.reflector.getAllAndOverride<boolean>(
        IS_ANY_AUTHENTICATED_KEY,
        [context.getHandler(), context.getClass()],
      );
      if (isAnyAuthenticated) return true;
      throw new ForbiddenException('No access policy declared on this route');
    }

    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;

    if (!requiredRoles.includes(user.role)) {
      throw new ForbiddenException('Você não tem permissão para acessar este recurso');
    }

    return true;
  }
}
