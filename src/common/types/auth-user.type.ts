import { UserRole } from '@prisma/client';

export interface AuthUser {
  id: string;
  clinicId: string | null;
  role: UserRole;
}
