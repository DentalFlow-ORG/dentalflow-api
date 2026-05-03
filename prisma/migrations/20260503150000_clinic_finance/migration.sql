CREATE TYPE "FinancialTransactionType" AS ENUM ('INCOME', 'EXPENSE');

CREATE TYPE "FinancialTransactionSource" AS ENUM (
    'MANUAL',
    'SERVICE_PAYMENT',
    'FIXED_EXPENSE',
    'ADJUSTMENT'
);

CREATE TYPE "FinancialTransactionStatus" AS ENUM (
    'PENDING',
    'PAID',
    'CANCELED'
);

CREATE TYPE "FixedExpenseRecurrence" AS ENUM ('MONTHLY', 'WEEKLY', 'YEARLY');

CREATE TABLE "financial_categories" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "FinancialTransactionType" NOT NULL,
    "color" TEXT,
    "icon" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "financial_categories_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "fixed_expenses" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "recurrence" "FixedExpenseRecurrence" NOT NULL DEFAULT 'MONTHLY',
    "dueDay" INTEGER NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "fixed_expenses_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "financial_transactions" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "type" "FinancialTransactionType" NOT NULL,
    "source" "FinancialTransactionSource" NOT NULL DEFAULT 'MANUAL',
    "categoryId" TEXT NOT NULL,
    "fixedExpenseId" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "description" TEXT NOT NULL,
    "transactionDate" DATE NOT NULL,
    "dueDate" DATE,
    "paidAt" TIMESTAMP(3),
    "status" "FinancialTransactionStatus" NOT NULL DEFAULT 'PENDING',
    "appointmentId" TEXT,
    "serviceId" TEXT,
    "profileId" TEXT,
    "paymentReference" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "financial_transactions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "financial_categories_clinicId_type_name_key"
ON "financial_categories"("clinicId", "type", "name");

CREATE INDEX "financial_categories_clinicId_idx"
ON "financial_categories"("clinicId");

CREATE INDEX "financial_categories_clinicId_type_idx"
ON "financial_categories"("clinicId", "type");

CREATE UNIQUE INDEX "financial_transactions_clinicId_appointmentId_source_key"
ON "financial_transactions"("clinicId", "appointmentId", "source");

CREATE UNIQUE INDEX "financial_transactions_clinicId_fixedExpenseId_dueDate_key"
ON "financial_transactions"("clinicId", "fixedExpenseId", "dueDate");

CREATE INDEX "financial_transactions_clinicId_idx"
ON "financial_transactions"("clinicId");

CREATE INDEX "financial_transactions_clinicId_transactionDate_idx"
ON "financial_transactions"("clinicId", "transactionDate");

CREATE INDEX "financial_transactions_clinicId_status_idx"
ON "financial_transactions"("clinicId", "status");

CREATE INDEX "financial_transactions_clinicId_type_idx"
ON "financial_transactions"("clinicId", "type");

CREATE INDEX "financial_transactions_categoryId_idx"
ON "financial_transactions"("categoryId");

CREATE INDEX "financial_transactions_serviceId_idx"
ON "financial_transactions"("serviceId");

CREATE INDEX "financial_transactions_profileId_idx"
ON "financial_transactions"("profileId");

CREATE INDEX "fixed_expenses_clinicId_idx"
ON "fixed_expenses"("clinicId");

CREATE INDEX "fixed_expenses_clinicId_isActive_idx"
ON "fixed_expenses"("clinicId", "isActive");

CREATE INDEX "fixed_expenses_categoryId_idx"
ON "fixed_expenses"("categoryId");

ALTER TABLE "financial_categories"
ADD CONSTRAINT "financial_categories_clinicId_fkey"
FOREIGN KEY ("clinicId") REFERENCES "clinics"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "fixed_expenses"
ADD CONSTRAINT "fixed_expenses_clinicId_fkey"
FOREIGN KEY ("clinicId") REFERENCES "clinics"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "fixed_expenses"
ADD CONSTRAINT "fixed_expenses_categoryId_fkey"
FOREIGN KEY ("categoryId") REFERENCES "financial_categories"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "fixed_expenses"
ADD CONSTRAINT "fixed_expenses_createdByUserId_fkey"
FOREIGN KEY ("createdByUserId") REFERENCES "users"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "financial_transactions"
ADD CONSTRAINT "financial_transactions_clinicId_fkey"
FOREIGN KEY ("clinicId") REFERENCES "clinics"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "financial_transactions"
ADD CONSTRAINT "financial_transactions_categoryId_fkey"
FOREIGN KEY ("categoryId") REFERENCES "financial_categories"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "financial_transactions"
ADD CONSTRAINT "financial_transactions_fixedExpenseId_fkey"
FOREIGN KEY ("fixedExpenseId") REFERENCES "fixed_expenses"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "financial_transactions"
ADD CONSTRAINT "financial_transactions_appointmentId_fkey"
FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "financial_transactions"
ADD CONSTRAINT "financial_transactions_serviceId_fkey"
FOREIGN KEY ("serviceId") REFERENCES "services"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "financial_transactions"
ADD CONSTRAINT "financial_transactions_profileId_fkey"
FOREIGN KEY ("profileId") REFERENCES "profiles"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "financial_transactions"
ADD CONSTRAINT "financial_transactions_createdByUserId_fkey"
FOREIGN KEY ("createdByUserId") REFERENCES "users"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
