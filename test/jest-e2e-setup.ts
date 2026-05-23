import { join } from 'node:path';
import { loadEnvFiles } from '../src/config/env-file.loader';

loadEnvFiles([
  join(process.cwd(), '.env.local'),
  join(process.cwd(), '.env'),
  join(process.cwd(), '.env.example'),
]);

if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test-secret-for-e2e-do-not-use-in-production';
}
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://localhost:5432/dentalflow_test';
}
