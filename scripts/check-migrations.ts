/**
 * Proves the committed migration history can build a database from nothing.
 *
 * This gate exists because the repository shipped a migration chain that could
 * not do that for months, and nothing noticed. `db push` cannot notice: it
 * builds the schema straight from `schema.prisma` and never opens
 * `prisma/migrations`, so a broken history passes it silently. Neither can the
 * test suites, for the same reason. Only applying the real migrations to a
 * real empty database can tell you, so that is what this does.
 *
 * It runs three scenarios against throwaway databases on the disposable
 * PostgreSQL server, dropping each afterwards:
 *
 *   1. FRESH    — empty database, full chain. The check the defect would have
 *                 failed.
 *   2. DRIFT    — the resulting schema against `schema.prisma`, which must now
 *                 match exactly. There is no allow-list: the orphaned
 *                 `website_leads` table was its only entry and has been
 *                 dropped. The catalog is also asked directly whether any
 *                 lead table survived, because that orphan existed in neither
 *                 schema.prisma nor the code for months while the chain kept
 *                 building it -- only PostgreSQL could have caught it.
 *   3. REPLAY   — an existing environment that already has the chain applied
 *                 receives only the migrations it is missing, they are no-ops,
 *                 and its data survives. This is what protects a production
 *                 database from a corrective migration.
 *
 * Never `db push`. That is the whole point.
 */
import { spawnSync } from 'node:child_process';
import { Client } from 'pg';

import { resolveTestDatabaseUrl } from '../test/support/test-database';

const baseUrl = resolveTestDatabaseUrl();

function scratchUrl(name: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function redact(url: string): string {
  return url.replace(/\/\/[^@]*@/, '//***@');
}

async function withAdminClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: baseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function withScratchClient<T>(
  name: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: scratchUrl(name) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function prisma(args: string, url: string, allowFailure = false): string {
  const result = spawnSync(`bunx prisma ${args}`, {
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
  });

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0 && !allowFailure) {
    console.error(output);
    throw new Error(`prisma ${args.split(' ')[0]} failed`);
  }
  return output;
}

function fail(message: string): never {
  console.error(`\n  FAILED  ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  console.log(`Migration history check against ${redact(baseUrl)}\n`);

  const dbName = `dentalflow_migration_check_${process.pid}`;

  await withAdminClient(async (client) => {
    await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await client.query(`CREATE DATABASE "${dbName}"`);
  });

  const url = scratchUrl(dbName);

  try {
    // ── 1. FRESH ─────────────────────────────────────────────────────────────
    console.log('  1. applying the full chain to an empty database');
    const applied = prisma(
      'migrate deploy --schema=prisma/schema.prisma',
      url,
      true,
    );
    if (!applied.includes('All migrations have been successfully applied')) {
      console.error(applied);
      fail('the migration history does not apply to an empty database');
    }
    const count = applied.match(/migration\.sql/g)?.length ?? 0;
    console.log(`     applied ${count} migrations`);

    // The orphan check, asked of PostgreSQL rather than of schema.prisma.
    // `website_leads` was modelled in neither for months while the chain kept
    // building it, so only the catalog can answer whether it is really gone.
    await withScratchClient(dbName, async (client) => {
      const orphans = await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables
          WHERE schemaname = 'public' AND tablename LIKE '%lead%'`,
      );
      if (orphans.rowCount !== 0) {
        fail(
          'the chain built a lead table schema.prisma does not model: ' +
            orphans.rows.map((row) => row.tablename).join(', '),
        );
      }
    });
    console.log('     no orphaned lead table in the catalog');

    // ── 2. DRIFT ─────────────────────────────────────────────────────────────
    console.log('  2. comparing the result against schema.prisma');
    const diff = prisma(
      'migrate diff --from-config-datasource --to-schema prisma/schema.prisma',
      url,
      true,
    );

    // No allow-list. The orphaned `website_leads` table was the only entry it
    // ever held, and 20260605000001_drop_orphaned_website_leads removed it, so
    // migrations and schema.prisma must now agree exactly.
    const unexpected = diff
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- ') || line.startsWith('[+]'))
      .map((line) => line.replace(/^-\s*/, ''))
      .filter((entry) => entry.length > 0);

    if (unexpected.length > 0) {
      console.error(diff);
      fail(
        `migrations and schema.prisma disagree about: ${unexpected.join(', ')}`,
      );
    }
    console.log('     migrations and schema.prisma agree exactly');

    // ── 3. REPLAY ────────────────────────────────────────────────────────────
    // An environment that already ran the chain must be able to receive a
    // later corrective migration without losing anything. Simulated by
    // planting a row, forgetting the corrective migrations, and re-deploying.
    console.log('  3. replaying corrective migrations over an existing database');

    const corrective = [
      '20260604230208_repair_lead_removal_prerequisites',
      '20260605000000_align_audit_action_enum',
      '20260605000001_drop_orphaned_website_leads',
    ];

    await withScratchClient(dbName, async (client) => {
      await client.query(
        `INSERT INTO "clinics" ("id", "name", "updatedAt")
         VALUES ('replay-clinic', 'Replay', NOW())`,
      );
      await client.query(
        `DELETE FROM "_prisma_migrations" WHERE "migration_name" = ANY($1)`,
        [corrective],
      );
    });

    const replayed = prisma(
      'migrate deploy --schema=prisma/schema.prisma',
      url,
      true,
    );
    if (!replayed.includes('All migrations have been successfully applied')) {
      console.error(replayed);
      fail('the corrective migrations cannot be replayed over an existing database');
    }

    await withScratchClient(dbName, async (client) => {
      const survived = await client.query(
        `SELECT 1 FROM "clinics" WHERE "id" = 'replay-clinic'`,
      );
      if (survived.rowCount !== 1) {
        fail('the replay destroyed existing data');
      }

      const leadValues = await client.query(
        `SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'AuditAction' AND e.enumlabel LIKE 'LEAD\\_%'`,
      );
      if (leadValues.rowCount !== 0) {
        fail('LEAD_* audit actions survived the chain');
      }

      // Re-running the drop against a database that no longer has the table
      // must be a no-op rather than an error -- the shape every environment
      // built from schema.prisma is already in.
      const stillGone = await client.query(
        `SELECT 1 FROM pg_tables
          WHERE schemaname = 'public' AND tablename = 'website_leads'`,
      );
      if (stillGone.rowCount !== 0) {
        fail('website_leads came back during the replay');
      }

      const invariants = await client.query(
        `SELECT
           (SELECT count(*) FROM pg_indexes
             WHERE indexname = 'users_one_owner_per_clinic_idx') AS owner_index,
           (SELECT count(*) FROM pg_constraint
             WHERE conname = 'users_role_clinic_scope_check') AS role_check`,
      );
      const row = invariants.rows[0] as { owner_index: string; role_check: string };
      if (Number(row.owner_index) !== 1 || Number(row.role_check) !== 1) {
        // These two are raw SQL that schema.prisma cannot express, so `db push`
        // never creates them. If they are missing, the suites are running
        // against a weaker schema than production.
        fail('the raw-SQL tenancy invariants are missing from the built schema');
      }
    });

    console.log('     replayed as no-ops, data intact, invariants present');
    console.log('\nMigration history check passed.');
  } finally {
    await withAdminClient(async (client) => {
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName],
      );
      await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
