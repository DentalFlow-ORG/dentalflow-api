-- AlterTable
ALTER TABLE "clinical_record_attachments" ADD COLUMN     "dataBase64" TEXT,
ADD COLUMN     "mimeType" TEXT,
ADD COLUMN     "sizeBytes" INTEGER,
ADD COLUMN     "thumbnailBase64" TEXT;
