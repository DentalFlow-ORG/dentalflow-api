import { UserRole } from '@prisma/client';

export interface AuthResponseUser {
  id: string;
  clinicId: string | null;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  isProfileComplete: boolean;
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthResponseUser;
}

export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

export interface LogoutResponse {
  success: true;
}

export interface MessageResponse {
  message: string;
}
