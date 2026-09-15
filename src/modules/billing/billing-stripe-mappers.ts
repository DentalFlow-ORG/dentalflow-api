import { BillingInterval, SubscriptionStatus } from '@prisma/client';

/** The subset of a Stripe Subscription that decides cancellation scheduling. */
export type StripeCancellationFields = {
  status: string;
  cancel_at_period_end: boolean;
  cancel_at?: number | null;
  ended_at?: number | null;
};

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

/**
 * Whether Stripe has a cancellation scheduled that has not taken effect yet.
 *
 * Stripe expresses the same intent two ways. An in-app cancellation sets
 * `cancel_at_period_end`, while a cancellation made through the hosted Billing
 * Portal sets `cancel_at` and leaves the boolean false. Reading only the
 * boolean loses every portal cancellation, so the subscription keeps reporting
 * itself as renewing until it silently expires.
 */
export function hasScheduledCancellation(
  subscription: StripeCancellationFields,
): boolean {
  // Already over: the cancellation is history, not a schedule.
  if (subscription.ended_at != null) return false;
  if (
    subscription.status === 'canceled' ||
    subscription.status === 'incomplete_expired'
  ) {
    return false;
  }

  if (subscription.cancel_at_period_end) return true;

  return subscription.cancel_at != null;
}

export function mapStripePriceInterval(
  interval: string | null | undefined,
): BillingInterval | null {
  if (interval === 'month') return BillingInterval.MONTHLY;
  if (interval === 'year') return BillingInterval.YEARLY;
  return null;
}
