import { NodeEnvironment } from '../common/types/environment.type';

function toNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsedValue = Number(value);

  return Number.isNaN(parsedValue) ? fallback : parsedValue;
}

function parseOrigins(value: string | undefined): string[] {
  const fallback = ['http://localhost:5173', 'http://127.0.0.1:5173'];
  const rawOrigins = value?.trim() ? value.split(',') : fallback;

  return rawOrigins
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

const frontendOrigins = parseOrigins(process.env.FRONTEND_ORIGIN);

export const appConfig = {
  name: 'DentalFlow API',
  apiPrefix: process.env.API_PREFIX ?? 'api',
  port: toNumber(process.env.PORT, 3000),
  nodeEnv: (process.env.NODE_ENV ?? 'development') as NodeEnvironment,
  frontendOrigin: frontendOrigins[0] ?? 'http://localhost:5173',
  frontendOrigins,
} as const;
