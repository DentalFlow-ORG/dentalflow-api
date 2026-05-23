-- CreateEnum
CREATE TYPE "AppointmentPaymentStatus" AS ENUM ('PAYMENT_PENDING', 'PAID', 'PARTIALLY_PAID', 'REFUNDED', 'CANCELED');

-- CreateEnum
CREATE TYPE "AppointmentPaymentMethod" AS ENUM ('CASH', 'CREDIT_CARD', 'DEBIT_CARD', 'PIX', 'BANK_TRANSFER', 'HEALTH_INSURANCE', 'OTHER');

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'APPOINTMENT_PAYMENT_UPDATED';

-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "estimatedAmountCents" INTEGER,
ADD COLUMN     "paidAmountCents" INTEGER,
ADD COLUMN     "paymentDate" TIMESTAMP(3),
ADD COLUMN     "paymentMethod" "AppointmentPaymentMethod",
ADD COLUMN     "paymentNotes" TEXT,
ADD COLUMN     "paymentStatus" "AppointmentPaymentStatus" NOT NULL DEFAULT 'PAYMENT_PENDING';
