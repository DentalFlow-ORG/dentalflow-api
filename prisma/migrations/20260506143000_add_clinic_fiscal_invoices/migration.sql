CREATE TYPE "FiscalDocumentType" AS ENUM ('CPF', 'CNPJ');

CREATE TYPE "FiscalTaxRegime" AS ENUM ('SIMPLES_NACIONAL', 'LUCRO_PRESUMIDO', 'LUCRO_REAL', 'MEI', 'OUTRO');

CREATE TYPE "FiscalProvider" AS ENUM ('LOCAL', 'FOCUS_NFE', 'NFE_IO', 'PLUGNOTAS', 'OTHER');

CREATE TYPE "FiscalProviderMode" AS ENUM ('LOCAL', 'SANDBOX', 'PRODUCTION');

CREATE TYPE "ServiceInvoiceStatus" AS ENUM ('DRAFT', 'READY_TO_ISSUE', 'SIMULATED', 'PROCESSING', 'ISSUED', 'FAILED', 'CANCELED');

CREATE TABLE "clinic_fiscal_profiles" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "tradeName" TEXT,
    "documentType" "FiscalDocumentType" NOT NULL,
    "documentNumber" TEXT NOT NULL,
    "municipalRegistration" TEXT,
    "stateRegistration" TEXT,
    "taxRegime" "FiscalTaxRegime" NOT NULL,
    "specialTaxRegime" TEXT,
    "serviceCode" TEXT,
    "cnae" TEXT,
    "issRate" DECIMAL(5,2),
    "addressStreet" TEXT NOT NULL,
    "addressNumber" TEXT NOT NULL,
    "addressComplement" TEXT,
    "addressNeighborhood" TEXT NOT NULL,
    "addressCity" TEXT NOT NULL,
    "addressState" TEXT NOT NULL,
    "addressZipCode" TEXT NOT NULL,
    "cityIbgeCode" TEXT,
    "fiscalProvider" "FiscalProvider" NOT NULL DEFAULT 'LOCAL',
    "fiscalProviderMode" "FiscalProviderMode" NOT NULL DEFAULT 'LOCAL',
    "isConfigured" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clinic_fiscal_profiles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "service_invoices" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT,
    "appointmentId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "updatedByUserId" TEXT,
    "issuedByUserId" TEXT,
    "externalInvoiceId" TEXT,
    "status" "ServiceInvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "environment" "FiscalProviderMode" NOT NULL DEFAULT 'LOCAL',
    "isLegalDocument" BOOLEAN NOT NULL DEFAULT false,
    "invoiceNumber" TEXT,
    "verificationCode" TEXT,
    "rpsNumber" TEXT,
    "rpsSeries" TEXT,
    "customerName" TEXT NOT NULL,
    "customerDocument" TEXT,
    "customerEmail" TEXT,
    "customerPhone" TEXT,
    "serviceDescription" TEXT NOT NULL,
    "serviceCode" TEXT,
    "amountCents" INTEGER NOT NULL,
    "deductionsCents" INTEGER,
    "issRate" DECIMAL(5,2),
    "issAmountCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "competenceDate" DATE NOT NULL,
    "simulatedIssueDate" TIMESTAMP(3),
    "issueDate" TIMESTAMP(3),
    "pdfUrl" TEXT,
    "xmlUrl" TEXT,
    "providerRawResponse" JSONB,
    "errorMessage" TEXT,
    "cancellationReason" TEXT,
    "canceledAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_invoices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "fiscal_invoice_events" (
    "id" TEXT NOT NULL,
    "serviceInvoiceId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "previousStatus" "ServiceInvoiceStatus",
    "nextStatus" "ServiceInvoiceStatus",
    "message" TEXT,
    "metadata" JSONB,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fiscal_invoice_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "clinic_fiscal_profiles_clinicId_key" ON "clinic_fiscal_profiles"("clinicId");
CREATE INDEX "clinic_fiscal_profiles_clinicId_idx" ON "clinic_fiscal_profiles"("clinicId");
CREATE INDEX "service_invoices_clinicId_idx" ON "service_invoices"("clinicId");
CREATE INDEX "service_invoices_clinicId_status_idx" ON "service_invoices"("clinicId", "status");
CREATE INDEX "service_invoices_clinicId_competenceDate_idx" ON "service_invoices"("clinicId", "competenceDate");
CREATE INDEX "service_invoices_appointmentId_idx" ON "service_invoices"("appointmentId");
CREATE INDEX "service_invoices_patientId_idx" ON "service_invoices"("patientId");
CREATE INDEX "fiscal_invoice_events_serviceInvoiceId_idx" ON "fiscal_invoice_events"("serviceInvoiceId");
CREATE INDEX "fiscal_invoice_events_eventType_idx" ON "fiscal_invoice_events"("eventType");

ALTER TABLE "clinic_fiscal_profiles" ADD CONSTRAINT "clinic_fiscal_profiles_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_invoices" ADD CONSTRAINT "service_invoices_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_invoices" ADD CONSTRAINT "service_invoices_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "service_invoices" ADD CONSTRAINT "service_invoices_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "service_invoices" ADD CONSTRAINT "service_invoices_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_invoices" ADD CONSTRAINT "service_invoices_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "service_invoices" ADD CONSTRAINT "service_invoices_issuedByUserId_fkey" FOREIGN KEY ("issuedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "fiscal_invoice_events" ADD CONSTRAINT "fiscal_invoice_events_serviceInvoiceId_fkey" FOREIGN KEY ("serviceInvoiceId") REFERENCES "service_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "fiscal_invoice_events" ADD CONSTRAINT "fiscal_invoice_events_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
