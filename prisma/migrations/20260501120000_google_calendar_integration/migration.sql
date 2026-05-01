ALTER TABLE "appointments"
ADD COLUMN IF NOT EXISTS "googleCalendarEventId" TEXT;

CREATE TABLE IF NOT EXISTS "google_calendar_integrations" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "connectedByUserId" TEXT NOT NULL,
    "googleCalendarId" TEXT NOT NULL DEFAULT 'primary',
    "googleCalendarSummary" TEXT,
    "accessTokenEncrypted" TEXT NOT NULL,
    "refreshTokenEncrypted" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "syncToken" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMP(3),
    "disconnectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "google_calendar_integrations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "google_calendar_integrations_clinicId_key"
ON "google_calendar_integrations"("clinicId");

CREATE INDEX IF NOT EXISTS "google_calendar_integrations_connectedByUserId_idx"
ON "google_calendar_integrations"("connectedByUserId");

CREATE TABLE IF NOT EXISTS "google_calendar_oauth_states" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "google_calendar_oauth_states_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "google_calendar_oauth_states_clinicId_idx"
ON "google_calendar_oauth_states"("clinicId");

CREATE INDEX IF NOT EXISTS "google_calendar_oauth_states_userId_idx"
ON "google_calendar_oauth_states"("userId");
