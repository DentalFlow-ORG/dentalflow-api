type CampaignIntervalConfig = {
  monthly: number;
  yearly?: number;
};

type LaunchCampaignConfig = {
  name: string;
  enabled: boolean;
  totalSpots: number;
  claimedSpots: number;
  promotionEndDate: string;
  promotionalPrices: Record<string, CampaignIntervalConfig>;
  compareAtPrices: Record<string, CampaignIntervalConfig>;
  coupons: Record<string, Partial<Record<'MONTHLY' | 'YEARLY', string>>>;
};

const DEFAULT_PROMOTION_END_DATE = '2026-06-01T02:59:59.000Z';

export const launchCampaignConfig: LaunchCampaignConfig = {
  name: 'Oferta de lançamento DentalFlow',
  enabled: process.env.BILLING_LAUNCH_CAMPAIGN_ENABLED !== 'false',
  totalSpots: Number(process.env.BILLING_LAUNCH_TOTAL_SPOTS ?? 100),
  claimedSpots: Number(process.env.BILLING_LAUNCH_CLAIMED_SPOTS ?? 93),
  promotionEndDate:
    process.env.BILLING_LAUNCH_PROMOTION_END_DATE ?? DEFAULT_PROMOTION_END_DATE,
  promotionalPrices: {
    starter: { monthly: 9_990 },
    professional: { monthly: 18_990 },
    premium: { monthly: 27_990 },
  },
  compareAtPrices: {
    starter: { monthly: 12_990 },
    professional: { monthly: 21_990 },
    premium: { monthly: 29_990 },
  },
  coupons: {
    starter: {
      MONTHLY: process.env.STRIPE_LAUNCH_COUPON_STARTER_MONTHLY,
    },
    professional: {
      MONTHLY: process.env.STRIPE_LAUNCH_COUPON_PROFESSIONAL_MONTHLY,
    },
    premium: {
      MONTHLY: process.env.STRIPE_LAUNCH_COUPON_PREMIUM_MONTHLY,
    },
  },
};
