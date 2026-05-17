-- ============================================================
-- Migration: 20260517100000_add_whatsapp_notification_module
-- Applied via: prisma migrate resolve --applied
-- Source commit: de6bc7e (feat: add simulated WhatsApp notification module)
-- Note: These changes were already applied to the DB via `prisma db push`.
--       This file documents those changes for migration history integrity.
-- ============================================================

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('WHATSAPP', 'SMS', 'EMAIL');

-- CreateEnum
CREATE TYPE "NotificationScope" AS ENUM ('UTILITY', 'MARKETING');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'READ', 'CONFIRMED', 'FAILED', 'OPTED_OUT');

-- CreateEnum
CREATE TYPE "NotificationTemplateCategory" AS ENUM ('UTILITY', 'MARKETING', 'SERVICE');

-- CreateEnum
CREATE TYPE "ConsentSource" AS ENUM ('MANUAL', 'FORM', 'IMPORT');

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'NOTIFICATION_SENT';
ALTER TYPE "AuditAction" ADD VALUE 'NOTIFICATION_CONSENT_GRANTED';
ALTER TYPE "AuditAction" ADD VALUE 'NOTIFICATION_CONSENT_REVOKED';

-- AlterTable (Plan — WhatsApp feature flags)
ALTER TABLE "plans"
  ADD COLUMN "hasWhatsApp"          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "whatsappMonthlyLimit" INTEGER,
  ADD COLUMN "whatsappAutoReminder" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "notification_consents" (
    "id"            TEXT NOT NULL,
    "clinicId"      TEXT NOT NULL,
    "patientUserId" TEXT,
    "entityType"    TEXT,
    "entityId"      TEXT,
    "phone"         TEXT NOT NULL,
    "channel"       "NotificationChannel" NOT NULL,
    "scope"         "NotificationScope" NOT NULL,
    "granted"       BOOLEAN NOT NULL DEFAULT false,
    "grantedAt"     TIMESTAMP(3),
    "revokedAt"     TIMESTAMP(3),
    "source"        "ConsentSource" NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id"                   TEXT NOT NULL,
    "clinicId"             TEXT NOT NULL,
    "whatsappEnabled"      BOOLEAN NOT NULL DEFAULT false,
    "autoReminder"         BOOLEAN NOT NULL DEFAULT false,
    "autoConfirmation"     BOOLEAN NOT NULL DEFAULT false,
    "reminderHoursBefore"  INTEGER NOT NULL DEFAULT 24,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_quotas" (
    "id"        TEXT NOT NULL,
    "clinicId"  TEXT NOT NULL,
    "month"     TEXT NOT NULL,
    "channel"   "NotificationChannel" NOT NULL,
    "used"      INTEGER NOT NULL DEFAULT 0,
    "limit"     INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_quotas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_messages" (
    "id"            TEXT NOT NULL,
    "clinicId"      TEXT NOT NULL,
    "consentId"     TEXT,
    "appointmentId" TEXT,
    "templateSlug"  TEXT NOT NULL,
    "channel"       "NotificationChannel" NOT NULL,
    "scope"         "NotificationScope" NOT NULL,
    "status"        "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "providerRef"   TEXT,
    "sentAt"        TIMESTAMP(3),
    "deliveredAt"   TIMESTAMP(3),
    "readAt"        TIMESTAMP(3),
    "failedAt"      TIMESTAMP(3),
    "failReason"    TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_templates" (
    "id"        TEXT NOT NULL,
    "slug"      TEXT NOT NULL,
    "channel"   "NotificationChannel" NOT NULL,
    "category"  "NotificationTemplateCategory" NOT NULL,
    "bodyPt"    TEXT NOT NULL,
    "variables" TEXT[],
    "isActive"  BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_clinicId_key" ON "notification_preferences"("clinicId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_quotas_clinicId_month_channel_key" ON "notification_quotas"("clinicId", "month", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "notification_templates_slug_key" ON "notification_templates"("slug");

-- CreateIndex
CREATE INDEX "notification_consents_clinicId_phone_channel_scope_idx" ON "notification_consents"("clinicId", "phone", "channel", "scope");

-- CreateIndex
CREATE INDEX "notification_consents_clinicId_patientUserId_idx" ON "notification_consents"("clinicId", "patientUserId");

-- CreateIndex
CREATE INDEX "notification_consents_clinicId_granted_idx" ON "notification_consents"("clinicId", "granted");

-- CreateIndex
CREATE INDEX "notification_quotas_clinicId_idx" ON "notification_quotas"("clinicId");

-- CreateIndex
CREATE INDEX "notification_messages_clinicId_idx" ON "notification_messages"("clinicId");

-- CreateIndex
CREATE INDEX "notification_messages_clinicId_appointmentId_idx" ON "notification_messages"("clinicId", "appointmentId");

-- CreateIndex
CREATE INDEX "notification_messages_clinicId_createdAt_idx" ON "notification_messages"("clinicId", "createdAt");

-- CreateIndex
CREATE INDEX "notification_messages_consentId_idx" ON "notification_messages"("consentId");

-- AddForeignKey
ALTER TABLE "notification_consents" ADD CONSTRAINT "notification_consents_clinicId_fkey"
    FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_consents" ADD CONSTRAINT "notification_consents_patientUserId_fkey"
    FOREIGN KEY ("patientUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_clinicId_fkey"
    FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_quotas" ADD CONSTRAINT "notification_quotas_clinicId_fkey"
    FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_messages" ADD CONSTRAINT "notification_messages_clinicId_fkey"
    FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_messages" ADD CONSTRAINT "notification_messages_consentId_fkey"
    FOREIGN KEY ("consentId") REFERENCES "notification_consents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_messages" ADD CONSTRAINT "notification_messages_appointmentId_fkey"
    FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
