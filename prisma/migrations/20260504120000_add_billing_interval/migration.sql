-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('MONTHLY', 'YEARLY');

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN "billingInterval" "BillingInterval";
