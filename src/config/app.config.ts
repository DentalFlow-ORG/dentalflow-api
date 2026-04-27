import { NodeEnvironment } from '../common/types/environment.type';

function toNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsedValue = Number(value);

  return Number.isNaN(parsedValue) ? fallback : parsedValue;
}

export const appConfig = {
  name: 'DentalFlow API',
  apiPrefix: process.env.API_PREFIX ?? 'api',
  port: toNumber(process.env.PORT, 3000),
  nodeEnv: (process.env.NODE_ENV ?? 'development') as NodeEnvironment,
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173',
  frontendLocalPath: process.env.FRONTEND_LOCAL_PATH ?? '',
} as const;
