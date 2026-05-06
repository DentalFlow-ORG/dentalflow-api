import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { FiscalController } from './fiscal.controller';
import { FiscalService } from './fiscal.service';
import { FISCAL_INVOICE_PROVIDER } from './fiscal.tokens';
import { LocalFiscalInvoiceProvider } from './providers/local-fiscal-invoice.provider';

export { FISCAL_INVOICE_PROVIDER } from './fiscal.tokens';

@Module({
  imports: [PrismaModule, CommonModule],
  controllers: [FiscalController],
  providers: [
    LocalFiscalInvoiceProvider,
    { provide: FISCAL_INVOICE_PROVIDER, useClass: LocalFiscalInvoiceProvider },
    FiscalService,
  ],
})
export class FiscalModule {}
