import {
  assertDisposableDatabaseUrl,
  DEFAULT_TEST_DATABASE_URL,
  UnsafeTestDatabaseError,
} from './test-database';

/**
 * The guard standing between a truncating test run and the shared Supabase
 * instance that `.env` points at.
 *
 * This is the one assertion in the repository that must never be allowed to
 * rot, so the rejection cases are spelled out individually — including the
 * exact production URL shape this project actually uses.
 */
describe('assertDisposableDatabaseUrl', () => {
  const ORIGINAL_APP_URL = process.env.DATABASE_URL;

  afterEach(() => {
    if (ORIGINAL_APP_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_APP_URL;
  });

  describe('accepts a local throwaway database', () => {
    it.each([
      DEFAULT_TEST_DATABASE_URL,
      'postgresql://u:p@localhost:5433/dentalflow_test',
      'postgres://u:p@127.0.0.1:5432/anything',
      'postgresql://u:p@postgres-test:5432/dentalflow_test',
      'postgresql://u:p@host.docker.internal:5433/dentalflow_test',
    ])('%s', (url) => {
      expect(assertDisposableDatabaseUrl(url)).toBe(url);
    });
  });

  describe('rejects anything managed', () => {
    it('rejects the project’s real Supabase pooler URL shape', () => {
      // The exact shape in .env — the accident this guard exists to prevent.
      expect(() =>
        assertDisposableDatabaseUrl(
          'postgresql://postgres.abcdefghijkl:secret@aws-1-sa-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true',
        ),
      ).toThrow(UnsafeTestDatabaseError);
    });

    it.each([
      ['supabase', 'postgresql://u:p@db.abcd.supabase.co:5432/postgres'],
      ['neon', 'postgresql://u:p@ep-cool.neon.tech/neondb'],
      ['render', 'postgresql://u:p@dpg-x.oregon-postgres.render.com/db'],
      ['rds', 'postgresql://u:p@x.eu-west-1.rds.amazonaws.com:5432/db'],
      ['railway', 'postgresql://u:p@containers.railway.app:6000/railway'],
      ['heroku', 'postgresql://u:p@ec2-1-2-3-4.compute.heroku.com:5432/d1'],
    ])('rejects a %s host', (_name, url) => {
      expect(() => assertDisposableDatabaseUrl(url)).toThrow(/managed host/);
    });

    it('rejects an unrecognised remote host even if it looks harmless', () => {
      expect(() =>
        assertDisposableDatabaseUrl(
          'postgresql://u:p@db.internal.corp:5432/test',
        ),
      ).toThrow(/not a recognised local host/);
    });
  });

  describe('rejects malformed or absent configuration', () => {
    it.each([undefined, '', '   '])('rejects %p', (url) => {
      expect(() => assertDisposableDatabaseUrl(url)).toThrow(/is not set/);
    });

    it('rejects a non-URL', () => {
      expect(() => assertDisposableDatabaseUrl('not-a-url')).toThrow(
        /not a valid URL/,
      );
    });

    it('rejects a non-PostgreSQL scheme', () => {
      expect(() =>
        assertDisposableDatabaseUrl('mysql://u:p@localhost:3306/test'),
      ).toThrow(/must be a PostgreSQL URL/);
    });
  });

  it('rejects a URL identical to the application’s own DATABASE_URL', () => {
    // Belt and braces: even a local URL is refused if it is the one the
    // application itself is configured with.
    process.env.DATABASE_URL = DEFAULT_TEST_DATABASE_URL;

    expect(() =>
      assertDisposableDatabaseUrl(DEFAULT_TEST_DATABASE_URL),
    ).toThrow(/identical to the application DATABASE_URL/);
  });

  it('explains how to start a safe database when it refuses', () => {
    expect(() => assertDisposableDatabaseUrl(undefined)).toThrow(
      /bun run test:db:up/,
    );
  });

  it('does not match a managed marker appearing only in the database name', () => {
    // The check is scoped to the host, so a local database called
    // "supabase_restore" is still usable.
    expect(() =>
      assertDisposableDatabaseUrl(
        'postgresql://u:p@127.0.0.1:5433/supabase_restore',
      ),
    ).not.toThrow();
  });
});
