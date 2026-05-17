const isProduction = process.env.NODE_ENV === 'production';

type EnvRule = {
  key: string;
  required: boolean;
  description: string;
};

const rules: EnvRule[] = [
  { key: 'JWT_SECRET', required: true, description: 'JWT signing secret' },
  { key: 'DATABASE_URL', required: true, description: 'PostgreSQL connection string' },
  { key: 'DIRECT_URL', required: isProduction, description: 'Direct PostgreSQL URL for Prisma migrations (bypasses PgBouncer)' },
  { key: 'FRONTEND_ORIGIN', required: isProduction, description: 'Allowed CORS origin' },
  { key: 'STRIPE_SECRET_KEY', required: isProduction, description: 'Stripe API secret key' },
  { key: 'STRIPE_WEBHOOK_SECRET', required: isProduction, description: 'Stripe webhook signing secret' },
  { key: 'STRIPE_SUCCESS_URL', required: isProduction, description: 'Stripe checkout success redirect URL' },
  { key: 'STRIPE_CANCEL_URL', required: isProduction, description: 'Stripe checkout cancel redirect URL' },
  { key: 'STRIPE_PORTAL_RETURN_URL', required: isProduction, description: 'Stripe portal return URL' },
  { key: 'GOOGLE_CALENDAR_CLIENT_ID', required: isProduction, description: 'Google Calendar OAuth client ID' },
  { key: 'GOOGLE_CALENDAR_CLIENT_SECRET', required: isProduction, description: 'Google Calendar OAuth client secret' },
  { key: 'GOOGLE_CALENDAR_REDIRECT_URI', required: isProduction, description: 'Google Calendar OAuth redirect URI (must match Google Cloud Console)' },
  { key: 'GOOGLE_CALENDAR_TOKEN_SECRET', required: isProduction, description: 'Secret for encrypting Google tokens' },
  { key: 'FISCAL_PROVIDER', required: false, description: 'Future fiscal provider identifier' },
  { key: 'FISCAL_PROVIDER_MODE', required: false, description: 'Future fiscal provider mode' },
];

export function validateEnv(): void {
  const missing: string[] = [];

  for (const rule of rules) {
    if (rule.required && !process.env[rule.key]) {
      missing.push(`  ${rule.key} — ${rule.description}`);
    }
  }

  if (missing.length > 0) {
    const env = isProduction ? 'production' : 'development';
    throw new Error(
      `Missing required environment variables (${env}):\n${missing.join('\n')}\n` +
        'Set them in .env or your deployment environment.',
    );
  }

  if (isProduction) {
    const origins = (process.env.FRONTEND_ORIGIN ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);

    if (origins.length === 0) {
      throw new Error('FRONTEND_ORIGIN is required in production.');
    }

    for (const origin of origins) {
      if (origin === '*' || !origin.startsWith('https://')) {
        throw new Error(
          'FRONTEND_ORIGIN must contain only explicit HTTPS origins in production.',
        );
      }
    }
  }
}
