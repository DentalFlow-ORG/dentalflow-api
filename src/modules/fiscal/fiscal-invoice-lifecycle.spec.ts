import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  NotImplementedException,
} from '@nestjs/common';
import { ServiceInvoiceStatus, UserRole } from '@prisma/client';

import { fiscalConfig } from '../../config/fiscal.config';
import { FiscalService } from './fiscal.service';

/**
 * Service invoices (NFS-e) and the clinic's fiscal profile.
 *
 * The module runs in simulation: nothing it produces has legal validity yet,
 * and the tests below pin that as an invariant rather than an accident, since
 * a document that silently claimed fiscal validity would be a regulatory
 * problem rather than a bug.
 *
 * The lifecycle is DRAFT → READY_TO_ISSUE → SIMULATED, with CANCELED reachable
 * from anything except a really-issued invoice. Only an OWNER may move an
 * invoice through it, and the clinic's fiscal profile must be complete —
 * including a structurally valid CPF or CNPJ — before anything can be issued.
 */

const CLINIC = 'clinic-1';
type FiscalUser = { id: string; role: UserRole };
const OWNER: FiscalUser = { id: 'owner-1', role: UserRole.OWNER };
const INVOICE = 'invoice-1';

/** A valid CPF and CNPJ, check digits included. */
const VALID_CPF = '52998224725';
const VALID_CNPJ = '11222333000181';

// A stored profile as upsert writes it: digits, upper-case UF, all required
// fields filled. The issue boundary re-checks these fields, not only the flag.
function configuredProfile(overrides: Record<string, unknown> = {}) {
  return {
    isConfigured: true,
    legalName: 'Clínica Sorriso LTDA',
    documentNumber: VALID_CNPJ,
    taxRegime: 'SIMPLES_NACIONAL',
    addressStreet: 'Rua A',
    addressNumber: '100',
    addressNeighborhood: 'Centro',
    addressCity: 'São Paulo',
    addressState: 'SP',
    addressZipCode: '01310100',
    ...overrides,
  };
}

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE,
    clinicId: CLINIC,
    status: ServiceInvoiceStatus.DRAFT,
    customerName: 'Maria Souza',
    customerDocument: VALID_CPF,
    serviceDescription: 'Limpeza',
    amountCents: 10_000,
    currency: 'BRL',
    competenceDate: new Date('2026-06-01T00:00:00.000Z'),
    ...overrides,
  };
}

function createPrisma() {
  return {
    serviceInvoice: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue(invoice()),
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: object }) =>
          Promise.resolve({ ...invoice(), ...data }),
        ),
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _sum: { amountCents: 0 } }),
    },
    clinicFiscalProfile: {
      findUnique: jest.fn().mockResolvedValue(configuredProfile()),
      upsert: jest.fn().mockResolvedValue({}),
    },
    fiscalInvoiceEvent: { create: jest.fn().mockResolvedValue({}) },
    appointment: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    user: { findFirst: jest.fn().mockResolvedValue(null) },
    // listInvoices runs its page and count in one transaction.
    $transaction: jest.fn((operations: unknown[]) => Promise.all(operations)),
  };
}

describe('FiscalService — invoice lifecycle', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let provider: { issueServiceInvoice: jest.Mock };
  let service: FiscalService;

  beforeEach(() => {
    prisma = createPrisma();
    provider = {
      issueServiceInvoice: jest.fn().mockResolvedValue({
        externalInvoiceId: 'ext-1',
        invoiceNumber: '000123',
        verificationCode: 'ABC123',
        simulatedIssueDate: new Date('2026-06-02T00:00:00.000Z'),
        rawResponse: { simulated: true },
      }),
    };
    service = new FiscalService(prisma as never, provider as never);
  });

  // ── Authorisation ──────────────────────────────────────────────────────────

  describe('owner-only actions', () => {
    it.each([
      ['markReady', (u: FiscalUser) => service.markReady(CLINIC, u, INVOICE)],
      [
        'simulateIssue',
        (u: FiscalUser) => service.simulateIssue(CLINIC, u, INVOICE),
      ],
      [
        'cancelInvoice',
        (u: FiscalUser) =>
          service.cancelInvoice(CLINIC, u, INVOICE, {
            reason: 'erro',
          } as never),
      ],
    ])('refuses %s for an assistant', async (_name, call) => {
      const assistant: FiscalUser = {
        id: 'assistant-1',
        role: UserRole.ASSISTANT,
      };

      await expect(call(assistant)).rejects.toThrow(ForbiddenException);
      expect(prisma.serviceInvoice.update).not.toHaveBeenCalled();
    });

    it('checks the role before reading the invoice', async () => {
      await service
        .markReady(CLINIC, { id: 'd', role: UserRole.DENTIST }, INVOICE)
        .catch(() => undefined);

      expect(prisma.serviceInvoice.findFirst).not.toHaveBeenCalled();
    });
  });

  // ── Tenant scoping ─────────────────────────────────────────────────────────

  describe('tenant scoping', () => {
    it('scopes the invoice lookup to the clinic', async () => {
      prisma.serviceInvoice.findFirst.mockResolvedValue(invoice());

      await service.getInvoice(CLINIC, INVOICE);

      expect(
        prisma.serviceInvoice.findFirst.mock.calls[0][0].where,
      ).toMatchObject({
        id: INVOICE,
        clinicId: CLINIC,
      });
    });

    it('reports an invoice from another clinic as not found', async () => {
      await expect(service.getInvoice(CLINIC, 'foreign')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── markReady ──────────────────────────────────────────────────────────────

  describe('markReady', () => {
    it('moves a draft to READY_TO_ISSUE and clears any previous error', async () => {
      prisma.serviceInvoice.findFirst.mockResolvedValue(invoice());

      await service.markReady(CLINIC, OWNER, INVOICE);

      expect(prisma.serviceInvoice.update.mock.calls[0][0].data).toMatchObject({
        status: ServiceInvoiceStatus.READY_TO_ISSUE,
        updatedByUserId: OWNER.id,
        errorMessage: null,
      });
    });

    it.each([
      ServiceInvoiceStatus.SIMULATED,
      ServiceInvoiceStatus.ISSUED,
      ServiceInvoiceStatus.CANCELED,
    ])('refuses to ready a %s invoice', async (status) => {
      prisma.serviceInvoice.findFirst.mockResolvedValue(invoice({ status }));

      await expect(service.markReady(CLINIC, OWNER, INVOICE)).rejects.toThrow(
        /não pode mais ser editada/,
      );
    });

    it('refuses when the clinic has no fiscal profile', async () => {
      prisma.serviceInvoice.findFirst.mockResolvedValue(invoice());
      prisma.clinicFiscalProfile.findUnique.mockResolvedValue(null);

      await expect(service.markReady(CLINIC, OWNER, INVOICE)).rejects.toThrow(
        /Configure os dados fiscais/,
      );
    });

    it('refuses when the stored profile flag says it is not configured', async () => {
      prisma.serviceInvoice.findFirst.mockResolvedValue(invoice());
      prisma.clinicFiscalProfile.findUnique.mockResolvedValue(
        configuredProfile({ isConfigured: false }),
      );

      await expect(service.markReady(CLINIC, OWNER, INVOICE)).rejects.toThrow(
        /Complete os dados fiscais/,
      );
    });

    it('lists the missing fields of a draft profile saved without CEP and UF', async () => {
      prisma.serviceInvoice.findFirst.mockResolvedValue(invoice());
      prisma.clinicFiscalProfile.findUnique.mockResolvedValue(
        configuredProfile({
          isConfigured: false,
          addressState: '',
          addressZipCode: '',
        }),
      );

      await expect(service.markReady(CLINIC, OWNER, INVOICE)).rejects.toThrow(
        'Complete os dados fiscais da clínica antes de continuar. Falta: UF, CEP.',
      );
      expect(prisma.serviceInvoice.update).not.toHaveBeenCalled();
    });

    it('refuses an invoice with a blank customer name', async () => {
      prisma.serviceInvoice.findFirst.mockResolvedValue(
        invoice({ customerName: '   ' }),
      );

      await expect(service.markReady(CLINIC, OWNER, INVOICE)).rejects.toThrow(
        /Nome do cliente/,
      );
    });

    it('refuses an invoice whose customer document is not a valid CPF or CNPJ', async () => {
      prisma.serviceInvoice.findFirst.mockResolvedValue(
        invoice({ customerDocument: '11111111111' }),
      );

      await expect(service.markReady(CLINIC, OWNER, INVOICE)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('accepts an invoice with no customer document at all', async () => {
      // The document is optional; only an invalid one is rejected.
      prisma.serviceInvoice.findFirst.mockResolvedValue(
        invoice({ customerDocument: null }),
      );

      await expect(
        service.markReady(CLINIC, OWNER, INVOICE),
      ).resolves.toBeDefined();
    });

    it('records the transition', async () => {
      prisma.serviceInvoice.findFirst.mockResolvedValue(invoice());

      await service.markReady(CLINIC, OWNER, INVOICE);

      expect(
        prisma.fiscalInvoiceEvent.create.mock.calls[0][0].data,
      ).toMatchObject({
        eventType: 'MARKED_READY',
      });
    });
  });

  // ── simulateIssue ──────────────────────────────────────────────────────────

  describe('simulateIssue', () => {
    const ready = () =>
      prisma.serviceInvoice.findFirst.mockResolvedValue(
        invoice({ status: ServiceInvoiceStatus.READY_TO_ISSUE }),
      );

    it('refuses to simulate while the fiscal profile is an incomplete draft', async () => {
      ready();
      prisma.clinicFiscalProfile.findUnique.mockResolvedValue(
        configuredProfile({ addressZipCode: '', addressStreet: ' ' }),
      );

      await expect(
        service.simulateIssue(CLINIC, OWNER, INVOICE),
      ).rejects.toThrow(/Falta: rua, CEP\./);
      expect(provider.issueServiceInvoice).not.toHaveBeenCalled();
    });

    it('refuses an invoice that has not been marked ready', async () => {
      prisma.serviceInvoice.findFirst.mockResolvedValue(invoice());

      await expect(
        service.simulateIssue(CLINIC, OWNER, INVOICE),
      ).rejects.toThrow(/pronta para emissão/);
      expect(provider.issueServiceInvoice).not.toHaveBeenCalled();
    });

    it('passes the invoice details to the provider', async () => {
      ready();

      await service.simulateIssue(CLINIC, OWNER, INVOICE);

      expect(provider.issueServiceInvoice).toHaveBeenCalledWith(
        expect.objectContaining({
          invoiceId: INVOICE,
          customerName: 'Maria Souza',
          amountCents: 10_000,
          currency: 'BRL',
        }),
      );
    });

    it('stores the provider’s identifiers on the invoice', async () => {
      ready();

      await service.simulateIssue(CLINIC, OWNER, INVOICE);

      expect(prisma.serviceInvoice.update.mock.calls[0][0].data).toMatchObject({
        status: ServiceInvoiceStatus.SIMULATED,
        externalInvoiceId: 'ext-1',
        invoiceNumber: '000123',
        verificationCode: 'ABC123',
        issuedByUserId: OWNER.id,
      });
    });

    it('marks the result as carrying no legal validity', async () => {
      // The single most important assertion in this module: a simulated
      // document must never present itself as a real fiscal one.
      ready();

      const result = await service.simulateIssue(CLINIC, OWNER, INVOICE);

      expect(
        prisma.serviceInvoice.update.mock.calls[0][0].data.isLegalDocument,
      ).toBe(false);
      expect(result.message).toMatch(/não possui validade fiscal/);
    });

    it('records the simulation with its lack of legal validity', async () => {
      ready();

      await service.simulateIssue(CLINIC, OWNER, INVOICE);

      expect(
        prisma.fiscalInvoiceEvent.create.mock.calls[0][0].data,
      ).toMatchObject({
        eventType: 'SIMULATED_ISSUE',
        metadata: { legalValidity: false },
      });
    });

    it('lets a provider failure surface rather than marking the invoice issued', async () => {
      ready();
      provider.issueServiceInvoice.mockRejectedValue(
        new Error('provider down'),
      );

      await expect(
        service.simulateIssue(CLINIC, OWNER, INVOICE),
      ).rejects.toThrow('provider down');
      expect(prisma.serviceInvoice.update).not.toHaveBeenCalled();
    });
  });

  // ── cancelInvoice ──────────────────────────────────────────────────────────

  describe('cancelInvoice', () => {
    it('cancels a draft and records the reason', async () => {
      prisma.serviceInvoice.findFirst.mockResolvedValue(invoice());

      await service.cancelInvoice(CLINIC, OWNER, INVOICE, {
        reason: 'Emitida por engano',
      } as never);

      expect(prisma.serviceInvoice.update.mock.calls[0][0].data).toMatchObject({
        status: ServiceInvoiceStatus.CANCELED,
        cancellationReason: 'Emitida por engano',
        isLegalDocument: false,
      });
    });

    it('stamps the cancellation time', async () => {
      prisma.serviceInvoice.findFirst.mockResolvedValue(invoice());

      await service.cancelInvoice(CLINIC, OWNER, INVOICE, {
        reason: 'x',
      } as never);

      expect(
        prisma.serviceInvoice.update.mock.calls[0][0].data.canceledAt,
      ).toBeInstanceOf(Date);
    });

    it('is idempotent for an already-cancelled invoice', async () => {
      prisma.serviceInvoice.findFirst.mockResolvedValue(
        invoice({ status: ServiceInvoiceStatus.CANCELED }),
      );

      await expect(
        service.cancelInvoice(CLINIC, OWNER, INVOICE, { reason: 'x' } as never),
      ).resolves.toBeDefined();
      expect(prisma.serviceInvoice.update).not.toHaveBeenCalled();
    });

    it('refuses to cancel an invoice really issued by a provider', async () => {
      // A real NFS-e is cancelled at the tax authority, not in this database.
      prisma.serviceInvoice.findFirst.mockResolvedValue(
        invoice({ status: ServiceInvoiceStatus.ISSUED }),
      );

      await expect(
        service.cancelInvoice(CLINIC, OWNER, INVOICE, { reason: 'x' } as never),
      ).rejects.toThrow(/provedor real/);
    });

    it('cancels a simulated invoice', async () => {
      prisma.serviceInvoice.findFirst.mockResolvedValue(
        invoice({ status: ServiceInvoiceStatus.SIMULATED }),
      );

      await expect(
        service.cancelInvoice(CLINIC, OWNER, INVOICE, { reason: 'x' } as never),
      ).resolves.toBeDefined();
    });
  });

  // ── Fiscal profile ─────────────────────────────────────────────────────────

  describe('fiscal profile', () => {
    const completeProfile = {
      legalName: 'Clínica Alpha LTDA',
      documentNumber: VALID_CNPJ,
      taxRegime: 'SIMPLES_NACIONAL',
      addressStreet: 'Rua A',
      addressNumber: '100',
      addressNeighborhood: 'Centro',
      addressCity: 'São Paulo',
      addressState: 'sp',
      addressZipCode: '01310-100',
    } as never;

    it('reports the module as operating without real issuing', async () => {
      const result = await service.getFiscalProfile(CLINIC);

      expect(result.realIssuingEnabled).toBe(false);
      expect(result.message).toMatch(/não está ativa/);
    });

    it('marks a complete profile as configured', async () => {
      await service.upsertFiscalProfile(CLINIC, completeProfile);

      expect(
        prisma.clinicFiscalProfile.upsert.mock.calls[0][0].create.isConfigured,
      ).toBe(true);
    });

    it('normalises the document and postcode to digits and the state to upper case', async () => {
      await service.upsertFiscalProfile(CLINIC, {
        ...(completeProfile as object),
        documentNumber: '11.222.333/0001-81',
      } as never);

      const created = prisma.clinicFiscalProfile.upsert.mock.calls[0][0].create;
      expect(created.documentNumber).toBe(VALID_CNPJ);
      expect(created.addressZipCode).toBe('01310100');
      expect(created.addressState).toBe('SP');
    });

    it.each([
      'legalName',
      'taxRegime',
      'addressStreet',
      'addressNumber',
      'addressNeighborhood',
      'addressCity',
      'addressState',
      'addressZipCode',
    ])('treats a profile missing %s as unconfigured', async (field) => {
      await service.upsertFiscalProfile(CLINIC, {
        ...(completeProfile as object),
        [field]: '   ',
      } as never);

      expect(
        prisma.clinicFiscalProfile.upsert.mock.calls[0][0].create.isConfigured,
      ).toBe(false);
    });

    it('treats a profile with an invalid document as unconfigured', async () => {
      await service.upsertFiscalProfile(CLINIC, {
        ...(completeProfile as object),
        documentNumber: '11111111111111',
      } as never);

      expect(
        prisma.clinicFiscalProfile.upsert.mock.calls[0][0].create.isConfigured,
      ).toBe(false);
    });

    it('accepts a valid CPF for a sole practitioner', async () => {
      await service.upsertFiscalProfile(CLINIC, {
        ...(completeProfile as object),
        documentNumber: VALID_CPF,
      } as never);

      expect(
        prisma.clinicFiscalProfile.upsert.mock.calls[0][0].create.isConfigured,
      ).toBe(true);
    });

    it('saves a draft with blank CEP and UF as an unconfigured profile', async () => {
      await service.upsertFiscalProfile(CLINIC, {
        ...(completeProfile as object),
        addressState: '',
        addressZipCode: '',
      } as never);

      const created = prisma.clinicFiscalProfile.upsert.mock.calls[0][0].create;
      expect(created.addressState).toBe('');
      expect(created.addressZipCode).toBe('');
      expect(created.isConfigured).toBe(false);
    });

    it('sets provider routing from server configuration and never on update', async () => {
      await service.upsertFiscalProfile(CLINIC, completeProfile);

      const { create, update } =
        prisma.clinicFiscalProfile.upsert.mock.calls[0][0];
      expect(create.fiscalProvider).toBe(fiscalConfig.provider);
      expect(create.fiscalProviderMode).toBe(fiscalConfig.providerMode);
      expect(update).not.toHaveProperty('fiscalProvider');
      expect(update).not.toHaveProperty('fiscalProviderMode');
    });

    it('writes the same values on create and on update', async () => {
      await service.upsertFiscalProfile(CLINIC, completeProfile);

      const { create, update } =
        prisma.clinicFiscalProfile.upsert.mock.calls[0][0];
      expect(update.documentNumber).toBe(create.documentNumber);
      expect(update.isConfigured).toBe(create.isConfigured);
    });
  });

  // ── Document validation ────────────────────────────────────────────────────

  describe('CPF and CNPJ validation', () => {
    const isValid = (value: string) =>
      (
        service as unknown as { isValidCpfOrCnpj(v: string): boolean }
      ).isValidCpfOrCnpj(value);

    it.each([VALID_CPF, '529.982.247-25', VALID_CNPJ, '11.222.333/0001-81'])(
      'accepts %s',
      (value) => {
        expect(isValid(value)).toBe(true);
      },
    );

    it.each([
      ['wrong CPF check digit', '52998224726'],
      ['wrong CNPJ check digit', '11222333000182'],
      ['all same digits (CPF)', '11111111111'],
      ['all same digits (CNPJ)', '11111111111111'],
      ['too short', '123'],
      ['too long', '123456789012345'],
      ['empty', ''],
      ['letters', 'abcdefghijk'],
    ])('rejects %s', (_name, value) => {
      expect(isValid(value)).toBe(false);
    });
  });

  // ── ISS calculation ────────────────────────────────────────────────────────

  describe('ISS calculation', () => {
    const iss = (amount: number, rate?: number | null) =>
      (
        service as unknown as {
          calculateIssCents(a: number, r?: number | null): number | null;
        }
      ).calculateIssCents(amount, rate);

    it('applies the rate as a percentage of the amount', () => {
      expect(iss(10_000, 5)).toBe(500);
    });

    it('rounds to the nearest cent', () => {
      expect(iss(10_033, 5)).toBe(502);
    });

    it('returns null when no rate is set, rather than zero', () => {
      // Null means "not applicable"; zero would claim a genuine 0% rate.
      expect(iss(10_000, null)).toBeNull();
      expect(iss(10_000, undefined)).toBeNull();
    });

    it('treats an explicit zero rate as zero tax', () => {
      expect(iss(10_000, 0)).toBe(0);
    });
  });

  // ── Documents that do not exist yet ────────────────────────────────────────

  describe('PDF and XML', () => {
    it('reports the PDF as not implemented rather than returning a fake', async () => {
      await expect(service.getInvoicePdf(CLINIC, INVOICE)).rejects.toThrow(
        NotImplementedException,
      );
    });

    it('reports the XML as not implemented rather than returning a fake', async () => {
      await expect(service.getInvoiceXml(CLINIC, INVOICE)).rejects.toThrow(
        NotImplementedException,
      );
    });

    it('says the document would have no fiscal validity', async () => {
      await expect(service.getInvoicePdf(CLINIC, INVOICE)).rejects.toThrow(
        /validade fiscal/,
      );
    });
  });

  // ── Listing ────────────────────────────────────────────────────────────────

  describe('listInvoices', () => {
    it('scopes the listing to the clinic', async () => {
      await service.listInvoices(CLINIC, {} as never);

      expect(
        prisma.serviceInvoice.findMany.mock.calls[0][0].where.clinicId,
      ).toBe(CLINIC);
    });

    it('filters by status when asked', async () => {
      await service.listInvoices(CLINIC, {
        status: ServiceInvoiceStatus.DRAFT,
      } as never);

      expect(prisma.serviceInvoice.findMany.mock.calls[0][0].where.status).toBe(
        ServiceInvoiceStatus.DRAFT,
      );
    });

    it('applies a competence date range', async () => {
      await service.listInvoices(CLINIC, {
        from: '2026-06-01',
        to: '2026-06-30',
      } as never);

      const where = prisma.serviceInvoice.findMany.mock.calls[0][0].where;
      expect(where.competenceDate.gte.toISOString()).toBe(
        '2026-06-01T00:00:00.000Z',
      );
      expect(where.competenceDate.lte.toISOString()).toBe(
        '2026-06-30T00:00:00.000Z',
      );
    });

    it('omits the date filter entirely when neither bound is given', async () => {
      await service.listInvoices(CLINIC, {} as never);

      expect(
        prisma.serviceInvoice.findMany.mock.calls[0][0].where,
      ).not.toHaveProperty('competenceDate');
    });
  });
});
