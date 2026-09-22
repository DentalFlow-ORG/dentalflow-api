/**
 * Applies the committed migration history to the disposable test database.
 *
 * This is the command that proves the migration chain is real. `db push`
 * cannot: it builds the schema straight from `schema.prisma` and never reads
 * `prisma/migrations`, so a chain that no longer applies to an empty database
 * passes it silently. That is exactly how the leads-removal defect survived.
 *
 * Two deliberate choices, matching `push-test-schema.ts`:
 *
 * 1. It imports the same guard the test suites use, rather than re-checking
 *    the URL its own way. One definition of "safe to destroy", used by all.
 *
 * 2. `prisma migrate deploy` has no `--url` flag — it reads the datasource
 *    from `prisma.config.ts`, which falls back to the `DATABASE_URL` in `.env`
 *    (the shared Supabase instance). So the child process is given an explicit
 *    `DATABASE_URL`/`DIRECT_URL` in its environment. `prisma.config.ts` loads
 *    dotenv, and dotenv does not overwrite variables that are already set, so
 *    the value below wins.
 */
import { spawnSync } from 'node:child_process';

import { resolveTestDatabaseUrl } from '../test/support/test-database';

const url = resolveTestDatabaseUrl();

const redacted = url.replace(/\/\/[^@]*@/, '//***@');
console.log(
  `Applying migration history to disposable test database: ${redacted}`,
);

const result = spawnSync(
  'bunx prisma migrate deploy --schema=prisma/schema.prisma',
  {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
  },
);

if (result.status !== 0) {
  console.error('\nThe committed migration history failed to apply.');
  console.error(
    'This is the check working: a fresh environment would fail the same way.',
  );
  console.error('Is the database running and empty?  bun run test:db:reset');
  process.exit(result.status ?? 1);
}
