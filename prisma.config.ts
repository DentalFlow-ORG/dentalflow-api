import { join } from 'node:path';
import { defineConfig } from 'prisma/config';
import { loadEnvFile } from './src/config/env-file.loader';

const projectRoot = process.cwd();
const envFromFile = {
  ...loadEnvFile(join(projectRoot, '.env.example')), // defaults
  ...loadEnvFile(join(projectRoot, '.env')),          // overrides defaults
};

const databaseUrl = process.env.DATABASE_URL ?? envFromFile.DATABASE_URL ?? '';
const directUrl   = process.env.DIRECT_URL   ?? envFromFile.DIRECT_URL   ?? databaseUrl;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: directUrl,
  },
});
