export type FiscalInvoiceProviderIssuePayload = {
  invoiceId: string;
  customerName: string;
  serviceDescription: string;
  amountCents: number;
  currency: string;
  competenceDate: Date;
};

export type FiscalInvoiceProviderIssueResult = {
  externalInvoiceId: string;
  status: 'SIMULATED';
  invoiceNumber: string;
  verificationCode: string;
  simulatedIssueDate: Date;
  isLegalDocument: false;
  message: string;
  rawResponse: Record<string, unknown>;
};

export interface FiscalInvoiceProvider {
  issueServiceInvoice(
    payload: FiscalInvoiceProviderIssuePayload,
  ): Promise<FiscalInvoiceProviderIssueResult>;
  getInvoiceStatus(externalInvoiceId: string): Promise<Record<string, unknown>>;
  cancelInvoice(
    externalInvoiceId: string,
    reason: string,
  ): Promise<Record<string, unknown>>;
  getInvoicePdf(externalInvoiceId: string): Promise<null>;
  getInvoiceXml(externalInvoiceId: string): Promise<null>;
}
