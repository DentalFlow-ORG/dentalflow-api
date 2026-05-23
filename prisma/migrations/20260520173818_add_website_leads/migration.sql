-- CreateTable
CREATE TABLE "website_leads" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "clinicName" TEXT,
    "preferredTime" TEXT,
    "context" TEXT,
    "consentGiven" BOOLEAN NOT NULL DEFAULT false,
    "consentAt" TIMESTAMP(3),
    "ipHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "website_leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "website_leads_phone_createdAt_idx" ON "website_leads"("phone", "createdAt");
