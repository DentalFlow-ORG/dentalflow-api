import { UserRole } from '@prisma/client';

export interface AuthUser {
  id: string;
  clinicId: string;
  role: UserRole;
}
