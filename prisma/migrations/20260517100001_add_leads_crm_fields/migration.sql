-- ============================================================
-- Migration: 20260517100001_add_leads_crm_fields
-- Applied via: prisma migrate resolve --applied
-- Source commit: b90fb61 (feat(leads): implementa módulo de Leads/CRM com CRUD completo)
-- Note: These changes were already applied to the DB via `prisma db push`.
--       This file documents those changes for migration history integrity.
-- ============================================================

-- AlterEnum (LeadSource — new acquisition channels)
ALTER TYPE "LeadSource" ADD VALUE 'WEBSITE';
ALTER TYPE "LeadSource" ADD VALUE 'WHATSAPP';
ALTER TYPE "LeadSource" ADD VALUE 'INSTAGRAM';
ALTER TYPE "LeadSource" ADD VALUE 'GOOGLE';
ALTER TYPE "LeadSource" ADD VALUE 'OTHER';

-- AlterEnum (AuditAction — lead lifecycle events)
ALTER TYPE "AuditAction" ADD VALUE 'LEAD_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'LEAD_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'LEAD_STATUS_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'LEAD_ACTIVITY_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'LEAD_CONVERTED';

-- AlterTable (Lead — next follow-up scheduling)
ALTER TABLE "leads" ADD COLUMN "nextFollowUpAt" TIMESTAMP(3);
