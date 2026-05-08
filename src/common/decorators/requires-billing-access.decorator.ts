import { SetMetadata } from '@nestjs/common';

export const REQUIRES_BILLING_ACCESS_KEY = 'requiresBillingAccess';
export const RequiresBillingAccess = () =>
  SetMetadata(REQUIRES_BILLING_ACCESS_KEY, true);
