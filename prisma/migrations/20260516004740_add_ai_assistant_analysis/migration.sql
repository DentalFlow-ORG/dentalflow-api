-- CreateEnum
CREATE TYPE "AiAssistantAnalysisType" AS ENUM ('FINANCE', 'INVENTORY');

-- CreateEnum
CREATE TYPE "AiAssistantAnalysisStatus" AS ENUM ('SUCCESS', 'ERROR');

-- CreateTable
CREATE TABLE "ai_assistant_analyses" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "userId" TEXT,
    "type" "AiAssistantAnalysisType" NOT NULL,
    "status" "AiAssistantAnalysisStatus" NOT NULL,
    "content" JSONB,
    "model" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_assistant_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_assistant_analyses_clinicId_type_generatedAt_idx" ON "ai_assistant_analyses"("clinicId", "type", "generatedAt");

-- CreateIndex
CREATE INDEX "ai_assistant_analyses_clinicId_type_status_idx" ON "ai_assistant_analyses"("clinicId", "type", "status");

-- AddForeignKey
ALTER TABLE "ai_assistant_analyses" ADD CONSTRAINT "ai_assistant_analyses_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_assistant_analyses" ADD CONSTRAINT "ai_assistant_analyses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
