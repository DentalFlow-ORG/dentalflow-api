export const googleAuthConfig = {
  enabled: process.env.GOOGLE_AUTH_ENABLED === 'true',
  clientId: process.env.GOOGLE_CLIENT_ID ?? '',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  callbackUrl:
    process.env.GOOGLE_CALLBACK_URL ??
    'http://localhost:3000/api/auth/google/callback',
} as const;
