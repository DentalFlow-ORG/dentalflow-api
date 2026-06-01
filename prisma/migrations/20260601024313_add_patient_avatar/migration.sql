-- CreateTable
CREATE TABLE "patient_avatars" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "patient_avatars_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "patient_avatars_clinicId_idx" ON "patient_avatars"("clinicId");

-- CreateIndex
CREATE UNIQUE INDEX "patient_avatars_clinicId_identifier_key" ON "patient_avatars"("clinicId", "identifier");

-- AddForeignKey
ALTER TABLE "patient_avatars" ADD CONSTRAINT "patient_avatars_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE CASCADE ON UPDATE CASCADE;
