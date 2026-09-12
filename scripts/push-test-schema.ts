/**
 * Applies the Prisma schema to the disposable integration-test database.
 *
 * Two deliberate choices:
 *
 * 1. It imports the same guard the test suite uses, rather than re-checking
 *    the URL its own way. One definition of "safe to destroy", used by both.
 *
 * 2. It passes `--url` explicitly. `prisma.config.ts` falls back to the
 *    `DATABASE_URL` in `.env` — the shared Supabase instance — so an
 *    environment variable alone is not protection enough. `--url` overrides the
 *    config file outright and makes the target impossible to mistake.
 *
 * `db push` rather than `migrate deploy` is not a shortcut: the migration
 * chain currently fails on a clean database (see the leads-removal migration),
 * and syncing from schema.prisma creates no migration files, which the task
 * forbids without approval.
 */
import { spawnSync } from 'node:child_process';

import { resolveTestDatabaseUrl } from '../test/support/test-database';

const url = resolveTestDatabaseUrl();

const redacted = url.replace(/\/\/[^@]*@/, '//***@');
console.log(`Applying Prisma schema to disposable test database: ${redacted}`);

// Single command string: `bunx` needs a shell on Windows, and passing an argv
// array alongside `shell: true` concatenates without escaping (DEP0190). The
// URL is safe to interpolate — `resolveTestDatabaseUrl` has already parsed it
// and confirmed a postgres scheme and a local host.
const result = spawnSync(
  `bunx prisma db push --schema=prisma/schema.prisma --url "${url}" --accept-data-loss`,
  { stdio: 'inherit', shell: true },
);

if (result.status !== 0) {
  console.error('\nFailed to apply the schema to the test database.');
  console.error('Is it running?  bun run test:db:up');
  process.exit(result.status ?? 1);
}
