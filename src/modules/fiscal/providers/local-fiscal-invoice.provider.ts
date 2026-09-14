import { Injectable } from '@nestjs/common';
import {
  FiscalInvoiceProvider,
  FiscalInvoiceProviderIssuePayload,
  FiscalInvoiceProviderIssueResult,
} from './fiscal-invoice-provider.interface';

@Injectable()
export class LocalFiscalInvoiceProvider implements FiscalInvoiceProvider {
  issueServiceInvoice(
    payload: FiscalInvoiceProviderIssuePayload,
  ): Promise<FiscalInvoiceProviderIssueResult> {
    const now = new Date();
    const suffix = payload.invoiceId.slice(-8).toUpperCase();

    return Promise.resolve({
      externalInvoiceId: `local-sim-${payload.invoiceId}`,
      status: 'SIMULATED',
      invoiceNumber: `SIM-${suffix}`,
      verificationCode: `SEM-VALIDADE-${suffix}`,
      simulatedIssueDate: now,
      isLegalDocument: false,
      message:
        'Simulação local concluída. Este retorno não representa uma NFS-e válida.',
      rawResponse: {
        provider: 'LOCAL',
        mode: 'LOCAL',
        legalValidity: false,
        notice:
          'Documento sem validade fiscal. Integração real ainda não configurada.',
        payload: {
          invoiceId: payload.invoiceId,
          customerName: payload.customerName,
          serviceDescription: payload.serviceDescription,
          amountCents: payload.amountCents,
          currency: payload.currency,
          competenceDate: payload.competenceDate.toISOString(),
        },
        generatedAt: now.toISOString(),
      },
    });
  }

  getInvoiceStatus(externalInvoiceId: string) {
    return Promise.resolve({
      externalInvoiceId,
      status: 'SIMULATED',
      legalValidity: false,
      message: 'Status local simulado. Documento sem validade fiscal.',
    });
  }

  cancelInvoice(externalInvoiceId: string, reason: string) {
    return Promise.resolve({
      externalInvoiceId,
      status: 'CANCELED',
      reason,
      legalValidity: false,
      message:
        'Cancelamento interno simulado. Nenhuma NFS-e real foi cancelada.',
    });
  }

  getInvoicePdf(): Promise<null> {
    return Promise.resolve(null);
  }

  getInvoiceXml(): Promise<null> {
    return Promise.resolve(null);
  }
}
