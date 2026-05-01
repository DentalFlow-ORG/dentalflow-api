export const googleCalendarConfig = {
  clientId: process.env.GOOGLE_CALENDAR_CLIENT_ID ?? '',
  clientSecret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET ?? '',
  redirectUri:
    process.env.GOOGLE_CALENDAR_REDIRECT_URI ??
    'http://localhost:3000/api/calendar-integrations/google/callback',
  tokenSecret: process.env.GOOGLE_CALENDAR_TOKEN_SECRET ?? '',
} as const;
