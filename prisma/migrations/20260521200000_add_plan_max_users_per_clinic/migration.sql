-- Add per-plan active user limit.
-- Default 8 matches the old hardcoded fallback; plan-specific values set below.
ALTER TABLE "plans" ADD COLUMN "maxUsersPerClinic" INTEGER NOT NULL DEFAULT 8;

-- Seed correct limits for the three active plans
UPDATE "plans" SET "maxUsersPerClinic" = 8  WHERE slug = 'starter';
UPDATE "plans" SET "maxUsersPerClinic" = 16 WHERE slug = 'professional';
UPDATE "plans" SET "maxUsersPerClinic" = 24 WHERE slug = 'premium';
