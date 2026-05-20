import { SetMetadata } from '@nestjs/common';
import { PlanFeature } from '../../modules/billing/plan-feature.types';

export const REQUIRES_PLAN_FEATURE_KEY = 'requiresPlanFeature';

export const RequirePlanFeature = (feature: PlanFeature) =>
  SetMetadata(REQUIRES_PLAN_FEATURE_KEY, feature);
