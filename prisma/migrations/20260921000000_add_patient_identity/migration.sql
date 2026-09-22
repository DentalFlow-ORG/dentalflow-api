-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "patientId" TEXT;

-- AlterTable
ALTER TABLE "clinical_records" ADD COLUMN     "patientId" TEXT;

-- AlterTable
ALTER TABLE "odontogram_records" ADD COLUMN     "patientId" TEXT;

-- AlterTable
ALTER TABLE "patient_avatars" ADD COLUMN     "patientId" TEXT;

-- CreateTable
CREATE TABLE "patients" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "patients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "patients_clinicId_idx" ON "patients"("clinicId");

-- CreateIndex
CREATE INDEX "patients_clinicId_email_idx" ON "patients"("clinicId", "email");

-- CreateIndex
CREATE INDEX "patients_clinicId_phone_idx" ON "patients"("clinicId", "phone");

-- CreateIndex
CREATE INDEX "patients_clinicId_name_idx" ON "patients"("clinicId", "name");

-- CreateIndex
CREATE INDEX "appointments_patientId_idx" ON "appointments"("patientId");

-- CreateIndex
CREATE INDEX "appointments_clinicId_patientId_idx" ON "appointments"("clinicId", "patientId");

-- CreateIndex
CREATE INDEX "clinical_records_clinicId_patientId_idx" ON "clinical_records"("clinicId", "patientId");

-- CreateIndex
CREATE INDEX "odontogram_records_clinicId_patientId_idx" ON "odontogram_records"("clinicId", "patientId");

-- CreateIndex
CREATE UNIQUE INDEX "patient_avatars_clinicId_patientId_key" ON "patient_avatars"("clinicId", "patientId");

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_records" ADD CONSTRAINT "clinical_records_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odontogram_records" ADD CONSTRAINT "odontogram_records_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_avatars" ADD CONSTRAINT "patient_avatars_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;
