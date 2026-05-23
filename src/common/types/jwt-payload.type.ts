import { UserRole } from '@prisma/client';

export interface JwtPayload {
  sub: string;
  clinicId: string | null;
  role: UserRole;
  tokenVersion: number;
}
