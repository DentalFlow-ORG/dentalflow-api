import 'dotenv/config';
import { join } from 'node:path';
import { defineConfig } from 'prisma/config';
import { loadEnvFile } from './src/config/env-file.loader';

const projectRoot = process.cwd();

// Carrega variáveis: defaults (.env.example) → override (.env)
const envFromFile = {
  ...loadEnvFile(join(projectRoot, '.env.example')),
  ...loadEnvFile(join(projectRoot, '.env')),
};

// Resolve URLs
const databaseUrl =
  process.env.DATABASE_URL ??
  envFromFile.DATABASE_URL ??
  '';

const directUrl =
  process.env.DIRECT_URL ??
  envFromFile.DIRECT_URL ??
  databaseUrl;

export default defineConfig({
  schema: 'prisma/schema.prisma',

  migrations: {
    path: 'prisma/migrations',
    seed: 'ts-node --project tsconfig.json prisma/seed.ts',
  },

  datasource: {
    // 👉 Prisma CLI (migrate/seed) usa conexão direta
    url: directUrl,
  },
});