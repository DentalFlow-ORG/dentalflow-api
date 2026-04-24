import { join } from 'node:path';
import { defineConfig } from 'prisma/config';
import { loadEnvFile } from './src/config/env-file.loader';

const projectRoot = process.cwd();
const envFromFile = {
  ...loadEnvFile(join(projectRoot, '.env')),
  ...loadEnvFile(join(projectRoot, '.env.example')),
};

const databaseUrl = process.env.DATABASE_URL ?? envFromFile.DATABASE_URL ?? '';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: databaseUrl,
  },
});
