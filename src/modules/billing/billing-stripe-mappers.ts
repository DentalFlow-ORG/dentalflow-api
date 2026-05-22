import { BillingInterval, SubscriptionStatus } from '@prisma/client';

export function mapStripeSubscriptionStatus(
  stripeStatus: string,
): SubscriptionStatus {
  const map: Record<string, SubscriptionStatus> = {
    trialing: SubscriptionStatus.TRIALING,
    active: SubscriptionStatus.ACTIVE,
    past_due: SubscriptionStatus.PAST_DUE,
    canceled: SubscriptionStatus.CANCELED,
    unpaid: SubscriptionStatus.UNPAID,
    paused: SubscriptionStatus.PAUSED,
    incomplete: SubscriptionStatus.INCOMPLETE,
    incomplete_expired: SubscriptionStatus.CANCELED,
  };

  return map[stripeStatus] ?? SubscriptionStatus.INCOMPLETE;
}

export function mapStripePriceInterval(
  interval: string | null | undefined,
): BillingInterval | null {
  if (interval === 'month') return BillingInterval.MONTHLY;
  if (interval === 'year') return BillingInterval.YEARLY;
  return null;
}
