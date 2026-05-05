import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { authConfig } from '../../config/auth.config';
import { AuthUser } from '../../common/types/auth-user.type';
import { JwtPayload } from '../../common/types/jwt-payload.type';
import { PrismaService } from '../../prisma/prisma.service';
import { AccessPolicyService } from '../../common/services/access-policy.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accessPolicy: AccessPolicyService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: authConfig.jwtSecret,
    });
  }

  async validate(payload: JwtPayload): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        clinicId: true,
        role: true,
        isActive: true,
        deletedAt: true,
        tokenVersion: true,
      },
    });

    if (!user || !user.isActive || user.deletedAt !== null) {
      throw new UnauthorizedException('Sessão inválida');
    }

    if (user.tokenVersion !== payload.tokenVersion) {
      throw new UnauthorizedException('Sessão inválida');
    }

    const authUser = { id: user.id, clinicId: user.clinicId, role: user.role };
    this.accessPolicy.assertValidRoleTenantShape(authUser);

    return authUser;
  }
}
