-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "dentistGoogleCalendarEventId" TEXT;

-- CreateTable
CREATE TABLE "user_google_calendar_integrations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
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
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_google_calendar_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_google_calendar_integrations_userId_key" ON "user_google_calendar_integrations"("userId");

-- CreateIndex
CREATE INDEX "user_google_calendar_integrations_clinicId_idx" ON "user_google_calendar_integrations"("clinicId");

-- AddForeignKey
ALTER TABLE "user_google_calendar_integrations" ADD CONSTRAINT "user_google_calendar_integrations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_google_calendar_integrations" ADD CONSTRAINT "user_google_calendar_integrations_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE CASCADE ON UPDATE CASCADE;
