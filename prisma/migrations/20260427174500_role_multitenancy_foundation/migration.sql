ALTER TABLE "users" ALTER COLUMN "clinicId" DROP NOT NULL;

DROP INDEX IF EXISTS "users_clinicId_email_key";
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE INDEX "users_role_idx" ON "users"("role");
CREATE UNIQUE INDEX "users_one_owner_per_clinic_idx"
ON "users"("clinicId")
WHERE "role" = 'OWNER' AND "deletedAt" IS NULL;

ALTER TABLE "users"
ADD CONSTRAINT "users_role_clinic_scope_check"
CHECK (
  (
    "role" IN ('ADMIN', 'PATIENT')
    AND "clinicId" IS NULL
  )
  OR (
    "role" IN ('OWNER', 'DENTIST', 'ASSISTANT')
    AND "clinicId" IS NOT NULL
  )
) NOT VALID;
