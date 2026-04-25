import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { JwtPayload } from '../../common/types/jwt-payload.type';
import { PrismaService } from '../../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { SignInDto } from './dto/sign-in.dto';

const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findFirst({
      where: { email: dto.email },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('Email already in use');
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    const user = await this.prisma.$transaction(async (tx) => {
      const clinic = await tx.clinic.create({
        data: { name: dto.clinicName },
      });

      return tx.user.create({
        data: {
          clinicId: clinic.id,
          email: dto.email,
          passwordHash,
          firstName: dto.firstName,
          lastName: dto.lastName,
          role: 'OWNER',
        },
        select: {
          id: true,
          clinicId: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
        },
      });
    });

    return { accessToken: this.sign(user.id, user.clinicId, user.role), user };
  }

  async signIn(dto: SignInDto) {
    const user = await this.prisma.user.findFirst({
      where: { email: dto.email, isActive: true, deletedAt: null },
      select: {
        id: true,
        clinicId: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        passwordHash: true,
      },
    });

    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const { passwordHash: _, ...safeUser } = user;
    return { accessToken: this.sign(user.id, user.clinicId, user.role), user: safeUser };
  }

  private sign(userId: string, clinicId: string, role: string): string {
    const payload: JwtPayload = { sub: userId, clinicId, role: role as any };
    return this.jwt.sign(payload);
  }
}
