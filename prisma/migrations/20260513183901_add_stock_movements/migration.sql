-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('IN', 'OUT', 'ADJUSTMENT', 'LOSS');

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "quantity" DECIMAL(10,3) NOT NULL,
    "previousQuantity" DECIMAL(10,3) NOT NULL,
    "newQuantity" DECIMAL(10,3) NOT NULL,
    "reason" TEXT,
    "notes" TEXT,
    "performedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_movements_clinicId_idx" ON "stock_movements"("clinicId");

-- CreateIndex
CREATE INDEX "stock_movements_productId_idx" ON "stock_movements"("productId");

-- CreateIndex
CREATE INDEX "stock_movements_clinicId_createdAt_idx" ON "stock_movements"("clinicId", "createdAt");

-- CreateIndex
CREATE INDEX "stock_movements_clinicId_type_idx" ON "stock_movements"("clinicId", "type");

-- CreateIndex
CREATE INDEX "stock_movements_performedByUserId_idx" ON "stock_movements"("performedByUserId");

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_productId_fkey" FOREIGN KEY ("productId") REFERENCES "stock_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_performedByUserId_fkey" FOREIGN KEY ("performedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
