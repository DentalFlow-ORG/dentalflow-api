-- CreateEnum
CREATE TYPE "ClinicalRecordStatus" AS ENUM ('DRAFT', 'COMPLETED', 'LOCKED', 'CANCELED');

-- CreateEnum
CREATE TYPE "ClinicalTemplateCategory" AS ENUM ('ANAMNESIS', 'EVOLUTION', 'PRESCRIPTION', 'RECOMMENDATION', 'PROCEDURE', 'OTHER');

-- DropIndex
DROP INDEX "clinic_fiscal_profiles_clinicId_idx";

-- DropIndex
DROP INDEX "fiscal_invoice_events_eventType_idx";

-- CreateTable
CREATE TABLE "clinical_records" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "profileId" TEXT NOT NULL,
    "patientName" TEXT NOT NULL,
    "patientEmail" TEXT,
    "patientPhone" TEXT,
    "status" "ClinicalRecordStatus" NOT NULL DEFAULT 'DRAFT',
    "chiefComplaint" TEXT,
    "anamnesis" TEXT,
    "clinicalEvolution" TEXT,
    "diagnosis" TEXT,
    "proceduresPerformed" TEXT,
    "treatmentPlan" TEXT,
    "prescription" TEXT,
    "recommendations" TEXT,
    "privateNotes" TEXT,
    "aiDraft" TEXT,
    "aiSummary" TEXT,
    "odontogramSnapshot" JSONB,
    "printedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lockedAt" TIMESTAMP(3),
    "createdByUserId" TEXT NOT NULL,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clinical_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical_record_events" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "clinicalRecordId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "previousStatus" "ClinicalRecordStatus",
    "nextStatus" "ClinicalRecordStatus",
    "message" TEXT,
    "metadata" JSONB,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clinical_record_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical_record_attachments" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "clinicalRecordId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT,
    "storageKey" TEXT,
    "description" TEXT,
    "uploadedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clinical_record_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical_templates" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "ClinicalTemplateCategory" NOT NULL DEFAULT 'OTHER',
    "content" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clinical_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "odontogram_records" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "patientEmail" TEXT,
    "patientName" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "odontogram_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "clinical_records_appointmentId_key" ON "clinical_records"("appointmentId");

-- CreateIndex
CREATE INDEX "clinical_records_clinicId_idx" ON "clinical_records"("clinicId");

-- CreateIndex
CREATE INDEX "clinical_records_clinicId_status_idx" ON "clinical_records"("clinicId", "status");

-- CreateIndex
CREATE INDEX "clinical_records_clinicId_patientEmail_idx" ON "clinical_records"("clinicId", "patientEmail");

-- CreateIndex
CREATE INDEX "clinical_records_clinicId_patientName_idx" ON "clinical_records"("clinicId", "patientName");

-- CreateIndex
CREATE INDEX "clinical_records_profileId_idx" ON "clinical_records"("profileId");

-- CreateIndex
CREATE INDEX "clinical_records_createdAt_idx" ON "clinical_records"("createdAt");

-- CreateIndex
CREATE INDEX "clinical_record_events_clinicalRecordId_idx" ON "clinical_record_events"("clinicalRecordId");

-- CreateIndex
CREATE INDEX "clinical_record_events_clinicalRecordId_createdAt_idx" ON "clinical_record_events"("clinicalRecordId", "createdAt");

-- CreateIndex
CREATE INDEX "clinical_record_attachments_clinicalRecordId_idx" ON "clinical_record_attachments"("clinicalRecordId");

-- CreateIndex
CREATE INDEX "clinical_templates_clinicId_idx" ON "clinical_templates"("clinicId");

-- CreateIndex
CREATE INDEX "clinical_templates_clinicId_isActive_idx" ON "clinical_templates"("clinicId", "isActive");

-- CreateIndex
CREATE INDEX "clinical_templates_clinicId_category_idx" ON "clinical_templates"("clinicId", "category");

-- CreateIndex
CREATE INDEX "odontogram_records_clinicId_idx" ON "odontogram_records"("clinicId");

-- CreateIndex
CREATE INDEX "odontogram_records_clinicId_patientEmail_idx" ON "odontogram_records"("clinicId", "patientEmail");

-- CreateIndex
CREATE INDEX "odontogram_records_clinicId_patientName_idx" ON "odontogram_records"("clinicId", "patientName");

-- CreateIndex
CREATE INDEX "fiscal_invoice_events_serviceInvoiceId_createdAt_idx" ON "fiscal_invoice_events"("serviceInvoiceId", "createdAt");

-- CreateIndex
CREATE INDEX "service_invoices_clinicId_createdAt_idx" ON "service_invoices"("clinicId", "createdAt");

-- AddForeignKey
ALTER TABLE "clinical_records" ADD CONSTRAINT "clinical_records_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_records" ADD CONSTRAINT "clinical_records_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_records" ADD CONSTRAINT "clinical_records_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_records" ADD CONSTRAINT "clinical_records_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_records" ADD CONSTRAINT "clinical_records_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_record_events" ADD CONSTRAINT "clinical_record_events_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_record_events" ADD CONSTRAINT "clinical_record_events_clinicalRecordId_fkey" FOREIGN KEY ("clinicalRecordId") REFERENCES "clinical_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_record_events" ADD CONSTRAINT "clinical_record_events_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_record_attachments" ADD CONSTRAINT "clinical_record_attachments_clinicalRecordId_fkey" FOREIGN KEY ("clinicalRecordId") REFERENCES "clinical_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_record_attachments" ADD CONSTRAINT "clinical_record_attachments_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_templates" ADD CONSTRAINT "clinical_templates_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_templates" ADD CONSTRAINT "clinical_templates_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odontogram_records" ADD CONSTRAINT "odontogram_records_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odontogram_records" ADD CONSTRAINT "odontogram_records_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
