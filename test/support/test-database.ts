/**
 * Resolves — and refuses to guess — the disposable database URL used by the
 * integration suite.
 *
 * This file exists because the failure it prevents is catastrophic and quiet.
 * `prisma.config.ts` falls back to the `DATABASE_URL` in `.env`, which on a
 * developer machine is the **shared Supabase instance holding real clinic
 * data**. A single `prisma migrate deploy` or a truncating test run against
 * that URL destroys production. So nothing here infers, defaults to, or
 * inherits a connection string: the URL must be explicitly a local throwaway,
 * and anything that even looks managed is rejected outright.
 */

/** Connection string for the docker-compose.test.yml service. */
export const DEFAULT_TEST_DATABASE_URL =
  'postgresql://dentalflow_test:dentalflow_test@127.0.0.1:5433/dentalflow_test';

/**
 * Hosts that are never a throwaway database. Matched against the URL's host
 * only, so a database *named* "supabase_backup" on localhost is still fine
 * while a localhost-looking username on a managed host is not.
 */
const MANAGED_HOST_MARKERS = [
  'supabase.co',
  'supabase.com',
  'pooler.supabase.com',
  'neon.tech',
  'render.com',
  'amazonaws.com',
  'azure.com',
  'googleapis.com',
  'planetscale',
  'railway.app',
  'heroku',
];

const LOCAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  'postgres-test',
  'host.docker.internal',
]);

export class UnsafeTestDatabaseError extends Error {
  constructor(message: string) {
    super(
      `${message}\n\n` +
        'The integration suite refuses to run against anything but a local,\n' +
        'disposable PostgreSQL. Start one and point DATABASE_URL_TEST at it:\n\n' +
        '  bun run test:db:up\n' +
        `  export DATABASE_URL_TEST="${DEFAULT_TEST_DATABASE_URL}"\n` +
        '  bun run test:integration\n',
    );
    this.name = 'UnsafeTestDatabaseError';
  }
}

/**
 * Throws unless `url` is unambiguously a local throwaway database.
 *
 * Exported so its own unit test can prove the guard rejects the real
 * production URL shape — the one assertion in this repository that must never
 * be allowed to rot.
 */
export function assertDisposableDatabaseUrl(url: string | undefined): string {
  if (!url || url.trim() === '') {
    throw new UnsafeTestDatabaseError('DATABASE_URL_TEST is not set.');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeTestDatabaseError(`DATABASE_URL_TEST is not a valid URL.`);
  }

  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    throw new UnsafeTestDatabaseError(
      `DATABASE_URL_TEST must be a PostgreSQL URL, got "${parsed.protocol}".`,
    );
  }

  const host = parsed.hostname.toLowerCase();

  const managed = MANAGED_HOST_MARKERS.find((marker) => host.includes(marker));
  if (managed) {
    throw new UnsafeTestDatabaseError(
      `DATABASE_URL_TEST points at a managed host ("${managed}"). ` +
        'That is never a disposable test database.',
    );
  }

  if (!LOCAL_HOSTS.has(host)) {
    throw new UnsafeTestDatabaseError(
      `DATABASE_URL_TEST host "${host}" is not a recognised local host.`,
    );
  }

  // Last line of defence: never the URL the application itself is configured
  // with, whatever it happens to be.
  const appUrl = process.env.DATABASE_URL;
  if (appUrl && appUrl.trim() === url.trim()) {
    throw new UnsafeTestDatabaseError(
      'DATABASE_URL_TEST is identical to the application DATABASE_URL.',
    );
  }

  return url;
}

/** The validated test database URL, or a thrown error explaining why not. */
export function resolveTestDatabaseUrl(): string {
  return assertDisposableDatabaseUrl(
    process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL,
  );
}
