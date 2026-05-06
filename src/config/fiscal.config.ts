import { FiscalProvider, FiscalProviderMode } from '@prisma/client';

export const fiscalConfig = {
  provider:
    (process.env.FISCAL_PROVIDER?.toUpperCase() as FiscalProvider | undefined) ??
    FiscalProvider.LOCAL,
  providerMode:
    (process.env.FISCAL_PROVIDER_MODE?.toUpperCase() as
      | FiscalProviderMode
      | undefined) ?? FiscalProviderMode.LOCAL,
} as const;
