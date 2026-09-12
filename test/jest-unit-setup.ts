/**
 * Deterministic environment for the unit/integration Jest project.
 *
 * Deliberately does NOT read `.env` — the developer `.env` carries live
 * credentials (database URL, JWT secret, provider keys) and no test may ever
 * depend on, or accidentally exercise, real infrastructure.
 *
 * Values here are fixed, obviously-fake test constants. Existing values are
 * never overwritten, so CI may still inject its own.
 */
const testEnv: Record<string, string> = {
  NODE_ENV: 'test',
  JWT_SECRET: 'unit-test-jwt-secret-not-a-real-secret',
  JWT_EXPIRES_IN: '15m',
  JWT_REFRESH_EXPIRES_IN: '7d',
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/dentalflow_unit_test',
  API_PREFIX: 'api',
  FRONTEND_ORIGIN: 'http://localhost:5173',
  FRONTEND_URL: 'http://localhost:5173',
  WHATSAPP_VERIFY_TOKEN: 'test-whatsapp-verify-token',
};

for (const [key, value] of Object.entries(testEnv)) {
  process.env[key] ??= value;
}
