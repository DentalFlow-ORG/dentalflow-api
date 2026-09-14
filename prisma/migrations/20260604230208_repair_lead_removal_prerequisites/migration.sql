-- Repairs the prerequisites of 20260604230209_remove_internal_leads.
--
-- That migration targets snake_case identifiers that never existed. The init
-- migration created camelCase ones:
--
--     it drops  "appointments_lead_id_idx"   actual: "appointments_leadId_idx"
--     it drops  "appointments"."lead_id"     actual: "appointments"."leadId"
--     it drops  "plans"."max_leads_per_month" actual: "plans"."maxLeadsPerMonth"
--
-- Every one of those statements carries IF EXISTS, so all three matched
-- nothing and silently did nothing. "appointments_leadId_fkey" therefore
-- survived, and the DROP TABLE "leads" two statements later failed:
--
--     ERROR: cannot drop table leads because other objects depend on it
--     DETAIL: constraint appointments_leadId_fkey on table appointments
--             depends on table leads
--     SQLSTATE 2BP01
--
-- deterministically, on every database built from this history.
--
-- The repair runs one second before the migration it repairs, so a fresh
-- environment arrives at the removal with the dependency already gone and its
-- three no-op statements stay no-ops. Nothing here is destructive twice: every
-- statement is guarded, so on a database where the cleanup already happened --
-- by hand, or because the removal migration was resolved as applied -- this
-- migration does nothing at all.

ALTER TABLE "appointments" DROP CONSTRAINT IF EXISTS "appointments_leadId_fkey";
DROP INDEX IF EXISTS "appointments_leadId_idx";
ALTER TABLE "appointments" DROP COLUMN IF EXISTS "leadId";
ALTER TABLE "plans" DROP COLUMN IF EXISTS "maxLeadsPerMonth";
