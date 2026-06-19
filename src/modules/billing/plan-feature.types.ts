/**
 * Feature keys that can be gated by plan.
 * AI and WhatsApp are already enforced by their own services (AiQuotaService,
 * NotificationService) and are NOT re-enforced here to avoid double-checking.
 */
export enum PlanFeature {
  FINANCE             = 'FINANCE',
  INVENTORY           = 'INVENTORY',
  FISCAL_CONTROL      = 'FISCAL_CONTROL',
  REPORTS             = 'REPORTS',
  GOOGLE_CALENDAR     = 'GOOGLE_CALENDAR',
  /** Premium-only: voice-based clinical record dictation via Whisper + GPT. */
  CLINICAL_DICTATION  = 'CLINICAL_DICTATION',
}

/**
 * Hard-coded capability table keyed by Plan.slug.
 * Reflects the commercial feature matrix in features.ts.
 *
 * If a plan slug is unknown (e.g. a future plan), the default is
 * no extra features — fail-safe over fail-open.
 */
const PLAN_FEATURE_TABLE: Record<string, ReadonlySet<PlanFeature>> = {
  starter: new Set<PlanFeature>([]),
  professional: new Set<PlanFeature>([
    PlanFeature.FINANCE,
    PlanFeature.INVENTORY,
    PlanFeature.FISCAL_CONTROL,
    PlanFeature.REPORTS,
    PlanFeature.GOOGLE_CALENDAR,
  ]),
  premium: new Set<PlanFeature>([
    PlanFeature.FINANCE,
    PlanFeature.INVENTORY,
    PlanFeature.FISCAL_CONTROL,
    PlanFeature.REPORTS,
    PlanFeature.GOOGLE_CALENDAR,
    PlanFeature.CLINICAL_DICTATION,
  ]),
} as const;

const EMPTY_FEATURES = new Set<PlanFeature>();

export function getPlanFeatures(planSlug: string | null): ReadonlySet<PlanFeature> {
  if (!planSlug) return EMPTY_FEATURES;
  return PLAN_FEATURE_TABLE[planSlug] ?? EMPTY_FEATURES;
}
