/**
 * Environment for the database-backed integration suite.
 *
 * Runs before any module is imported, so `DATABASE_URL` is already pointing at
 * the disposable database by the time `PrismaService` reads it at construction
 * — that is what lets these tests exercise the real client against a real
 * PostgreSQL rather than a mock.
 *
 * The URL is validated first. `resolveTestDatabaseUrl` throws unless it is
 * unambiguously a local throwaway, which is the guard standing between a test
 * run and the shared Supabase instance in `.env`.
 */
import { resolveTestDatabaseUrl } from '../support/test-database';

const testDatabaseUrl = resolveTestDatabaseUrl();

// Overwritten, not defaulted: whatever `.env` holds must not win here.
process.env.DATABASE_URL = testDatabaseUrl;
process.env.DIRECT_URL = testDatabaseUrl;

const fixedEnv: Record<string, string> = {
  NODE_ENV: 'test',
  JWT_SECRET: 'integration-test-jwt-secret-not-a-real-secret',
  JWT_EXPIRES_IN: '15m',
  JWT_REFRESH_EXPIRES_IN: '7d',
  API_PREFIX: 'api',
  FRONTEND_ORIGIN: 'http://localhost:5173',
  FRONTEND_URL: 'http://localhost:5173',
  WHATSAPP_VERIFY_TOKEN: 'test-whatsapp-verify-token',
  // Deliberately absent: STRIPE_SECRET_KEY, OPENAI_API_KEY, RESEND_API_KEY,
  // GOOGLE_CALENDAR_*. No integration test may reach a real provider, and an
  // unset key makes that a loud failure rather than a silent live call.
};

for (const [key, value] of Object.entries(fixedEnv)) {
  process.env[key] = value;
}
