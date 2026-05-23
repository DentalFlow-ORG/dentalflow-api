-- CreateTable
CREATE TABLE "stock_categories" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_products" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'unidade',
    "currentQuantity" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "minQuantity" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "purchasePrice" INTEGER,
    "supplier" TEXT,
    "expiresAt" DATE,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_products_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_categories_clinicId_idx" ON "stock_categories"("clinicId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_categories_clinicId_name_key" ON "stock_categories"("clinicId", "name");

-- CreateIndex
CREATE INDEX "stock_products_clinicId_idx" ON "stock_products"("clinicId");

-- CreateIndex
CREATE INDEX "stock_products_categoryId_idx" ON "stock_products"("categoryId");

-- CreateIndex
CREATE INDEX "stock_products_clinicId_isActive_idx" ON "stock_products"("clinicId", "isActive");

-- CreateIndex
CREATE INDEX "stock_products_expiresAt_idx" ON "stock_products"("expiresAt");

-- AddForeignKey
ALTER TABLE "stock_categories" ADD CONSTRAINT "stock_categories_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_products" ADD CONSTRAINT "stock_products_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_products" ADD CONSTRAINT "stock_products_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "stock_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
