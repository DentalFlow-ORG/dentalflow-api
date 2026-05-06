CREATE TABLE "subscription_items" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "stripeSubscriptionItemId" TEXT NOT NULL,
    "stripePriceId" TEXT NOT NULL,
    "priceNickname" TEXT,
    "billingInterval" "BillingInterval",
    "unitAmount" INTEGER,
    "unitAmountDecimal" TEXT,
    "currency" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "subscription_items_stripeSubscriptionItemId_key" ON "subscription_items"("stripeSubscriptionItemId");

CREATE INDEX "subscription_items_subscriptionId_idx" ON "subscription_items"("subscriptionId");

CREATE INDEX "subscription_items_stripePriceId_idx" ON "subscription_items"("stripePriceId");

ALTER TABLE "subscription_items" ADD CONSTRAINT "subscription_items_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
