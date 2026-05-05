-- AlterTable
ALTER TABLE "users" ADD COLUMN     "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "appointments_clinicId_appointmentDate_idx" ON "appointments"("clinicId", "appointmentDate");

-- CreateIndex
CREATE INDEX "appointments_profileId_appointmentDate_idx" ON "appointments"("profileId", "appointmentDate");

-- CreateIndex
CREATE INDEX "appointments_clinicId_profileId_appointmentDate_idx" ON "appointments"("clinicId", "profileId", "appointmentDate");

-- CreateIndex
CREATE INDEX "appointments_clinicId_status_appointmentDate_idx" ON "appointments"("clinicId", "status", "appointmentDate");

-- AddForeignKey
ALTER TABLE "google_calendar_integrations" ADD CONSTRAINT "google_calendar_integrations_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_calendar_integrations" ADD CONSTRAINT "google_calendar_integrations_connectedByUserId_fkey" FOREIGN KEY ("connectedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_calendar_oauth_states" ADD CONSTRAINT "google_calendar_oauth_states_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_calendar_oauth_states" ADD CONSTRAINT "google_calendar_oauth_states_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
