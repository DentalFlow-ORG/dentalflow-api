ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "patientUserId" TEXT;

CREATE INDEX IF NOT EXISTS "appointments_patientUserId_idx"
ON "appointments"("patientUserId");

CREATE UNIQUE INDEX IF NOT EXISTS "availability_profileId_dayOfWeek_startTime_endTime_key"
ON "availability"("profileId", "dayOfWeek", "startTime", "endTime");

ALTER TABLE "availability"
ADD CONSTRAINT "availability_clinicId_fkey"
FOREIGN KEY ("clinicId") REFERENCES "clinics"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "availability_exceptions"
ADD CONSTRAINT "availability_exceptions_clinicId_fkey"
FOREIGN KEY ("clinicId") REFERENCES "clinics"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "appointments"
ADD CONSTRAINT "appointments_clinicId_fkey"
FOREIGN KEY ("clinicId") REFERENCES "clinics"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "appointments"
ADD CONSTRAINT "appointments_patientUserId_fkey"
FOREIGN KEY ("patientUserId") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
