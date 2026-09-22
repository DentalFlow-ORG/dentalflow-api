import { join } from 'node:path';
import { loadEnvFiles } from './env-file.loader';

loadEnvFiles([
  join(process.cwd(), '.env.local'),
  join(process.cwd(), '.env'),
  join(process.cwd(), '.env.example'),
]);
