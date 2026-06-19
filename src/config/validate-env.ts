const isProduction = process.env.NODE_ENV === 'production';

type EnvRule = {
  key: string;
  required: boolean;
  description: string;
};

const rules: EnvRule[] = [
  { key: 'JWT_SECRET', required: true, description: 'JWT signing secret' },
  { key: 'DATABASE_URL', required: true, description: 'PostgreSQL connection string' },
  {
    key: 'WHATSAPP_VERIFY_TOKEN',
    required: true,
    description: 'Meta WhatsApp webhook verification token',
  },
  { key: 'DIRECT_URL', required: isProduction, description: 'Direct PostgreSQL URL for Prisma migrations (bypasses PgBouncer)' },
  { key: 'FRONTEND_ORIGIN', required: isProduction, description: 'Allowed CORS origin' },
  { key: 'FRONTEND_URL', required: isProduction, description: 'Frontend base URL for transactional email links (e.g. https://app.dentalflow.com.br)' },
  { key: 'STRIPE_SECRET_KEY', required: isProduction, description: 'Stripe API secret key' },
  { key: 'STRIPE_WEBHOOK_SECRET', required: isProduction, description: 'Stripe webhook signing secret' },
  { key: 'STRIPE_SUCCESS_URL', required: isProduction, description: 'Stripe checkout success redirect URL' },
  { key: 'STRIPE_CANCEL_URL', required: isProduction, description: 'Stripe checkout cancel redirect URL' },
  { key: 'STRIPE_PORTAL_RETURN_URL', required: isProduction, description: 'Stripe portal return URL' },
  { key: 'GOOGLE_CALENDAR_CLIENT_ID', required: isProduction, description: 'Google Calendar OAuth client ID' },
  { key: 'GOOGLE_CALENDAR_CLIENT_SECRET', required: isProduction, description: 'Google Calendar OAuth client secret' },
  { key: 'GOOGLE_CALENDAR_REDIRECT_URI', required: isProduction, description: 'Google Calendar OAuth redirect URI (must match Google Cloud Console)' },
  { key: 'GOOGLE_CALENDAR_TOKEN_SECRET', required: isProduction, description: 'Secret for encrypting Google tokens' },
  { key: 'RESEND_API_KEY', required: false, description: 'Resend API key for transactional email (optional — omit to use stub logging in dev/test)' },
  { key: 'MAIL_FROM', required: false, description: 'Sender address for transactional email, required when RESEND_API_KEY is set (e.g. "DentalFlow <no-reply@your-domain.com>")' },
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
    // OPENAI_API_KEY is only required when AI assistant is enabled.
    // Set OPENAI_AI_ASSISTANT_ENABLED=false to disable AI features and skip this check.
    const aiEnabled = process.env.OPENAI_AI_ASSISTANT_ENABLED !== 'false';
    if (aiEnabled && !process.env.OPENAI_API_KEY) {
      throw new Error(
        'OPENAI_API_KEY is required in production when OPENAI_AI_ASSISTANT_ENABLED is not "false".\n' +
          'Set OPENAI_API_KEY in your environment or set OPENAI_AI_ASSISTANT_ENABLED=false to disable AI.',
      );
    }

    // WhatsApp Cloud API vars are only required when real sending is explicitly enabled.
    if (
      process.env.NOTIFICATION_PROVIDER === 'whatsapp_cloud' &&
      process.env.WHATSAPP_CLOUD_API_ENABLED === 'true'
    ) {
      const whatsappRequired = [
        'WHATSAPP_CLOUD_API_VERSION',
        'WHATSAPP_CLOUD_PHONE_NUMBER_ID',
        'WHATSAPP_CLOUD_ACCESS_TOKEN',
        'WHATSAPP_VERIFY_TOKEN',
        'WHATSAPP_DEFAULT_LANGUAGE',
      ];
      const missingWhatsapp = whatsappRequired.filter((k) => !process.env[k]);
      if (
        !process.env.WHATSAPP_APP_SECRET &&
        !process.env.WHATSAPP_WEBHOOK_APP_SECRET
      ) {
        missingWhatsapp.push('WHATSAPP_APP_SECRET');
      }
      if (missingWhatsapp.length > 0) {
        throw new Error(
          `NOTIFICATION_PROVIDER=whatsapp_cloud requires the following env vars:\n` +
            missingWhatsapp.map((k) => `  ${k}`).join('\n') +
            '\nSet them or set NOTIFICATION_PROVIDER=local to use the simulated provider.',
        );
      }
    }

    const frontendUrl = process.env.FRONTEND_URL ?? '';
    if (!frontendUrl.startsWith('https://')) {
      throw new Error(
        'FRONTEND_URL must use HTTPS in production (e.g. https://app.dentalflow.com.br).',
      );
    }

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

  const googleAuthEnabled = process.env.GOOGLE_AUTH_ENABLED === 'true';
  if (googleAuthEnabled) {
    const requiredGoogleAuth = [
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'GOOGLE_CALLBACK_URL',
      'FRONTEND_AUTH_SUCCESS_URL',
      'FRONTEND_AUTH_COMPLETE_PROFILE_URL',
    ];
    const missingGoogleAuth = requiredGoogleAuth.filter((key) => !process.env[key]);

    if (missingGoogleAuth.length > 0) {
      throw new Error(
        `GOOGLE_AUTH_ENABLED=true requires the following env vars:\n` +
          missingGoogleAuth.map((key) => `  ${key}`).join('\n'),
      );
    }

    if (
      isProduction &&
      (!process.env.GOOGLE_CALLBACK_URL?.startsWith('https://') ||
        !process.env.FRONTEND_AUTH_SUCCESS_URL?.startsWith('https://') ||
        !process.env.FRONTEND_AUTH_COMPLETE_PROFILE_URL?.startsWith('https://'))
    ) {
      throw new Error(
        'Google OAuth redirect URLs must use HTTPS in production.',
      );
    }

    const allowedOrigins = (process.env.FRONTEND_ORIGIN ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
    const frontendRedirects = [
      process.env.FRONTEND_AUTH_SUCCESS_URL,
      process.env.FRONTEND_AUTH_COMPLETE_PROFILE_URL,
    ];

    for (const redirect of frontendRedirects) {
      if (!redirect) continue;
      const redirectOrigin = new URL(redirect).origin;
      if (allowedOrigins.length > 0 && !allowedOrigins.includes(redirectOrigin)) {
        throw new Error(
          'Google OAuth frontend redirect URLs must use an origin listed in FRONTEND_ORIGIN.',
        );
      }
    }
  }
}
