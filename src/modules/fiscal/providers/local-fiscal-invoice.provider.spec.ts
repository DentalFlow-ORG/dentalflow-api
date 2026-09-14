import { LocalFiscalInvoiceProvider } from './local-fiscal-invoice.provider';

/**
 * The simulated NFS-e provider.
 *
 * It is a stand-in for a real municipal integration that does not exist yet,
 * and what it returns is written to the database and shown to the clinic. The
 * property under test is therefore not "does it work" but "does it ever claim
 * to be real": every field it produces has to be legible as a simulation, at
 * the row level, so a clinic cannot mistake the result for a tax document.
 */

const payload = {
  invoiceId: 'invoice-abcdef123456',
  customerName: 'Maria Souza',
  serviceDescription: 'Limpeza',
  amountCents: 10_000,
  currency: 'BRL',
  competenceDate: new Date('2026-06-01T00:00:00.000Z'),
};

describe('LocalFiscalInvoiceProvider', () => {
  let provider: LocalFiscalInvoiceProvider;

  beforeEach(() => {
    provider = new LocalFiscalInvoiceProvider();
  });

  describe('issuing', () => {
    it('never claims legal validity', async () => {
      const result = await provider.issueServiceInvoice(payload as never);

      expect(result.isLegalDocument).toBe(false);
      expect(result.status).toBe('SIMULATED');
    });

    it('marks every identifier it mints as a simulation', async () => {
      const result = await provider.issueServiceInvoice(payload as never);

      // These strings reach the clinic's screen and any export of it.
      expect(result.externalInvoiceId).toBe('local-sim-invoice-abcdef123456');
      expect(result.invoiceNumber).toBe('SIM-EF123456');
      expect(result.verificationCode).toBe('SEM-VALIDADE-EF123456');
    });

    it('says in words that the return is not an NFS-e', async () => {
      const result = await provider.issueServiceInvoice(payload as never);

      expect(result.message).toContain('não representa uma NFS-e válida');
    });

    it('stamps the moment it simulated the issue', async () => {
      const result = await provider.issueServiceInvoice(payload as never);

      expect(result.simulatedIssueDate).toBeInstanceOf(Date);
    });

    it('records what it was asked to issue, for the audit trail', async () => {
      const result = await provider.issueServiceInvoice(payload as never);

      expect(result.rawResponse).toMatchObject({
        provider: 'LOCAL',
        mode: 'LOCAL',
        legalValidity: false,
      });
      expect(
        (result.rawResponse as { payload: Record<string, unknown> }).payload,
      ).toMatchObject({
        invoiceId: payload.invoiceId,
        customerName: 'Maria Souza',
        amountCents: 10_000,
        competenceDate: '2026-06-01T00:00:00.000Z',
      });
    });

    it('handles an invoice id shorter than the suffix it derives', async () => {
      const result = await provider.issueServiceInvoice({
        ...payload,
        invoiceId: 'ab',
      } as never);

      expect(result.invoiceNumber).toBe('SIM-AB');
    });
  });

  describe('the other operations', () => {
    it('reports a simulated status for whatever it is asked about', async () => {
      const result = await provider.getInvoiceStatus('ext-1');

      expect(result).toMatchObject({
        externalInvoiceId: 'ext-1',
        status: 'SIMULATED',
        legalValidity: false,
      });
    });

    it('simulates a cancellation, echoing the reason', async () => {
      const result = await provider.cancelInvoice('ext-1', 'erro de digitação');

      expect(result).toMatchObject({
        externalInvoiceId: 'ext-1',
        status: 'CANCELED',
        reason: 'erro de digitação',
        legalValidity: false,
      });
      // Nothing real was cancelled, and the message has to say so.
      expect(result.message).toContain('Nenhuma NFS-e real foi cancelada');
    });

    it('produces no PDF, rather than an empty one', async () => {
      // A blank file would look like a document that failed to render; null
      // is the honest answer while no provider exists.
      await expect(provider.getInvoicePdf()).resolves.toBeNull();
    });

    it('produces no XML', async () => {
      await expect(provider.getInvoiceXml()).resolves.toBeNull();
    });
  });
});
