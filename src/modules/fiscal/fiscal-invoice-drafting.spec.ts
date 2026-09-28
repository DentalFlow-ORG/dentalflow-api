import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ServiceInvoiceStatus, UserRole } from '@prisma/client';

import { FiscalService } from './fiscal.service';

/**
 * Drafting a service invoice: creating one, editing it, and the two read
 * surfaces the UI builds a draft from.
 *
 * The lifecycle suite next door covers the transitions and who may make them.
 * This covers what goes *into* an invoice, which is where the money and the
 * customer's tax document live. Three things it pins:
 *
 *  - ISS is derived from the amount and the rate on every write, so a rate
 *    change cannot leave a stale tax figure behind;
 *  - an appointment can carry at most one live invoice, or the clinic bills
 *    the same treatment twice;
 *  - a linked patient must be a real PATIENT account. Without that check the
 *    id could name another clinic's owner or a platform admin.
 */

const CLINIC = 'clinic-1';
const APPOINTMENT = 'appointment-1';
const OWNER = { id: 'owner-1', role: UserRole.OWNER };
const ASSISTANT = { id: 'assistant-1', role: UserRole.ASSISTANT };

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'invoice-1',
    clinicId: CLINIC,
    status: ServiceInvoiceStatus.DRAFT,
    customerName: 'Maria Souza',
    customerDocument: '52998224725',
    serviceDescription: 'Limpeza',
    amountCents: 10_000,
    issRate: null,
    competenceDate: new Date('2026-06-01T00:00:00.000Z'),
    ...overrides,
  };
}

function appointmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: APPOINTMENT,
    clinicId: CLINIC,
    patientName: 'Maria Souza',
    patientEmail: 'maria@example.test',
    patientPhone: '11999999999',
    appointmentDate: new Date('2026-06-15T00:00:00.000Z'),
    paymentStatus: 'PAID',
    estimatedAmountCents: 12_000,
    paidAmountCents: 10_000,
    profile: { id: 'profile-1', displayName: 'Dra. Ana' },
    service: { id: 'service-1', name: 'Limpeza' },
    ...overrides,
  };
}

function createPrisma() {
  return {
    serviceInvoice: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue(invoiceRow()),
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: object }) =>
          Promise.resolve({ ...invoiceRow(), ...data }),
        ),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    clinicFiscalProfile: {
      findUnique: jest.fn().mockResolvedValue({ isConfigured: true }),
      upsert: jest.fn().mockResolvedValue({}),
    },
    fiscalInvoiceEvent: { create: jest.fn().mockResolvedValue({}) },
    appointment: {
      findFirst: jest.fn().mockResolvedValue(appointmentRow()),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    user: { findFirst: jest.fn().mockResolvedValue({ id: 'patient-1' }) },
    $transaction: jest.fn((operations: unknown[]) => Promise.all(operations)),
  };
}

describe('FiscalService — drafting an invoice', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let service: FiscalService;

  beforeEach(() => {
    prisma = createPrisma();
    service = new FiscalService(
      prisma as never,
      { issueServiceInvoice: jest.fn() } as never,
    );
  });

  function createDto(overrides: Record<string, unknown> = {}) {
    return {
      customerName: 'Maria Souza',
      serviceDescription: 'Limpeza',
      amountCents: 10_000,
      competenceDate: '2026-06-01',
      ...overrides,
    } as never;
  }

  // ── Creating ───────────────────────────────────────────────────────────────

  describe('creating', () => {
    it('writes the invoice into the caller’s clinic as a local draft', async () => {
      await service.createInvoice(CLINIC, OWNER, createDto());

      expect(prisma.serviceInvoice.create.mock.calls[0][0].data).toMatchObject({
        clinicId: CLINIC,
        createdByUserId: OWNER.id,
        environment: 'LOCAL',
        // The module simulates. A document claiming fiscal validity would be a
        // regulatory problem, not a bug.
        isLegalDocument: false,
      });
    });

    it('trims the customer name and the service description', async () => {
      await service.createInvoice(
        CLINIC,
        OWNER,
        createDto({
          customerName: '  Maria Souza  ',
          serviceDescription: '  Limpeza  ',
        }),
      );

      expect(prisma.serviceInvoice.create.mock.calls[0][0].data).toMatchObject({
        customerName: 'Maria Souza',
        serviceDescription: 'Limpeza',
      });
    });

    it('stores the customer document as digits only', async () => {
      await service.createInvoice(
        CLINIC,
        OWNER,
        createDto({ customerDocument: '529.982.247-25' }),
      );

      expect(
        prisma.serviceInvoice.create.mock.calls[0][0].data.customerDocument,
      ).toBe('52998224725');
    });

    it('stores no document when none is given', async () => {
      await service.createInvoice(CLINIC, OWNER, createDto());

      expect(
        prisma.serviceInvoice.create.mock.calls[0][0].data.customerDocument,
      ).toBeNull();
    });

    it('derives the ISS amount from the rate', async () => {
      await service.createInvoice(
        CLINIC,
        OWNER,
        createDto({ amountCents: 10_000, issRate: 5 }),
      );

      // 5% of R$100,00 is R$5,00.
      expect(
        prisma.serviceInvoice.create.mock.calls[0][0].data.issAmountCents,
      ).toBe(500);
    });

    it('rounds the ISS amount to whole centavos', async () => {
      await service.createInvoice(
        CLINIC,
        OWNER,
        createDto({ amountCents: 3_333, issRate: 2.5 }),
      );

      expect(
        prisma.serviceInvoice.create.mock.calls[0][0].data.issAmountCents,
      ).toBe(83);
    });

    it('leaves the ISS amount unset when no rate applies', async () => {
      await service.createInvoice(CLINIC, OWNER, createDto());

      expect(
        prisma.serviceInvoice.create.mock.calls[0][0].data.issAmountCents,
      ).toBeNull();
    });

    it('falls back to the clinic’s configured service code', async () => {
      prisma.clinicFiscalProfile.findUnique.mockResolvedValue({
        isConfigured: true,
        serviceCode: '04.01',
      });

      await service.createInvoice(CLINIC, OWNER, createDto());

      expect(
        prisma.serviceInvoice.create.mock.calls[0][0].data.serviceCode,
      ).toBe('04.01');
    });

    it('prefers the service code the caller supplied', async () => {
      prisma.clinicFiscalProfile.findUnique.mockResolvedValue({
        isConfigured: true,
        serviceCode: '04.01',
      });

      await service.createInvoice(
        CLINIC,
        OWNER,
        createDto({ serviceCode: '17.05' }),
      );

      expect(
        prisma.serviceInvoice.create.mock.calls[0][0].data.serviceCode,
      ).toBe('17.05');
    });

    it('stores the competence date as UTC midnight of that day', async () => {
      await service.createInvoice(
        CLINIC,
        OWNER,
        createDto({ competenceDate: '2026-06-01' }),
      );

      const stored = prisma.serviceInvoice.create.mock.calls[0][0].data
        .competenceDate as Date;
      expect(stored.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    });

    it('records the draft in the invoice’s event trail', async () => {
      await service.createInvoice(CLINIC, OWNER, createDto());

      expect(
        prisma.fiscalInvoiceEvent.create.mock.calls[0][0].data,
      ).toMatchObject({
        eventType: 'DRAFT_CREATED',
        createdByUserId: OWNER.id,
      });
    });

    it('refuses a second live invoice for the same appointment', async () => {
      prisma.serviceInvoice.findFirst.mockResolvedValue({ id: 'existing' });

      // Billing one treatment twice is the failure this prevents.
      await expect(
        service.createInvoice(
          CLINIC,
          OWNER,
          createDto({ appointmentId: APPOINTMENT }),
        ),
      ).rejects.toThrow(ConflictException);
      expect(prisma.serviceInvoice.create).not.toHaveBeenCalled();
    });

    it('ignores a cancelled invoice when checking for a duplicate', async () => {
      await service.createInvoice(
        CLINIC,
        OWNER,
        createDto({ appointmentId: APPOINTMENT }),
      );

      expect(
        prisma.serviceInvoice.findFirst.mock.calls[0][0].where,
      ).toMatchObject({
        clinicId: CLINIC,
        appointmentId: APPOINTMENT,
        status: { not: ServiceInvoiceStatus.CANCELED },
      });
    });

    it('refuses an appointment from another clinic', async () => {
      prisma.appointment.findFirst.mockResolvedValue(null);

      await expect(
        service.createInvoice(
          CLINIC,
          OWNER,
          createDto({ appointmentId: 'foreign' }),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.serviceInvoice.create).not.toHaveBeenCalled();
    });

    it('refuses a patient id that is not a patient account', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.createInvoice(
          CLINIC,
          OWNER,
          createDto({ patientId: 'some-owner' }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts only an active, undeleted PATIENT as the linked patient', async () => {
      await service.createInvoice(
        CLINIC,
        OWNER,
        createDto({ patientId: 'patient-1' }),
      );

      // Without the role predicate the id could name another clinic's owner.
      expect(prisma.user.findFirst.mock.calls[0][0].where).toEqual({
        id: 'patient-1',
        role: UserRole.PATIENT,
        isActive: true,
        deletedAt: null,
      });
    });
  });

  // ── Editing ────────────────────────────────────────────────────────────────

  describe('editing', () => {
    beforeEach(() => {
      prisma.serviceInvoice.findFirst.mockResolvedValue(invoiceRow());
    });

    it('writes only the fields the caller sent', async () => {
      await service.updateInvoice(CLINIC, OWNER, 'invoice-1', {
        customerName: 'Ana Lima',
      } as never);

      expect(prisma.serviceInvoice.update.mock.calls[0][0].data).toMatchObject({
        customerName: 'Ana Lima',
      });
      expect(
        prisma.serviceInvoice.update.mock.calls[0][0].data,
      ).not.toHaveProperty('serviceDescription');
    });

    it('clears the optional contact fields, service code and notes on null', async () => {
      await service.updateInvoice(CLINIC, OWNER, 'invoice-1', {
        customerDocument: null,
        customerEmail: null,
        customerPhone: null,
        serviceCode: null,
        notes: null,
      } as never);

      expect(prisma.serviceInvoice.update.mock.calls[0][0].data).toMatchObject({
        customerDocument: null,
        customerEmail: null,
        customerPhone: null,
        serviceCode: null,
        notes: null,
      });
    });

    it('records who made the change', async () => {
      await service.updateInvoice(CLINIC, OWNER, 'invoice-1', {
        notes: 'x',
      } as never);

      expect(
        prisma.serviceInvoice.update.mock.calls[0][0].data.updatedByUser,
      ).toEqual({ connect: { id: OWNER.id } });
    });

    it('recomputes ISS when the rate changes, using the stored amount', async () => {
      prisma.serviceInvoice.findFirst.mockResolvedValue(
        invoiceRow({ amountCents: 20_000, issRate: null }),
      );

      await service.updateInvoice(CLINIC, OWNER, 'invoice-1', {
        issRate: 3,
      } as never);

      expect(
        prisma.serviceInvoice.update.mock.calls[0][0].data.issAmountCents,
      ).toBe(600);
    });

    it('recomputes ISS when the amount changes, using the stored rate', async () => {
      prisma.serviceInvoice.findFirst.mockResolvedValue(
        invoiceRow({ amountCents: 10_000, issRate: 5 }),
      );

      await service.updateInvoice(CLINIC, OWNER, 'invoice-1', {
        amountCents: 40_000,
      } as never);

      // A stale ISS figure against a new amount is a wrong tax number on a
      // document, so it is derived on every write rather than carried over.
      expect(
        prisma.serviceInvoice.update.mock.calls[0][0].data.issAmountCents,
      ).toBe(2_000);
    });

    it('disconnects the appointment when the caller clears it', async () => {
      await service.updateInvoice(CLINIC, OWNER, 'invoice-1', {
        appointmentId: null,
      } as never);

      expect(
        prisma.serviceInvoice.update.mock.calls[0][0].data.appointment,
      ).toEqual({ disconnect: true });
    });

    it('connects a new appointment after checking it belongs here', async () => {
      await service.updateInvoice(CLINIC, OWNER, 'invoice-1', {
        appointmentId: APPOINTMENT,
      } as never);

      expect(
        prisma.serviceInvoice.update.mock.calls[0][0].data.appointment,
      ).toEqual({ connect: { id: APPOINTMENT } });
    });

    it('disconnects the patient when the caller clears it', async () => {
      await service.updateInvoice(CLINIC, OWNER, 'invoice-1', {
        patientId: null,
      } as never);

      expect(
        prisma.serviceInvoice.update.mock.calls[0][0].data.patient,
      ).toEqual({ disconnect: true });
    });

    it('lets an assistant edit a draft', async () => {
      await expect(
        service.updateInvoice(CLINIC, ASSISTANT, 'invoice-1', {
          notes: 'x',
        } as never),
      ).resolves.toBeDefined();
    });

    it('refuses an assistant editing anything past draft', async () => {
      prisma.serviceInvoice.findFirst.mockResolvedValue(
        invoiceRow({ status: ServiceInvoiceStatus.READY_TO_ISSUE }),
      );

      await expect(
        service.updateInvoice(CLINIC, ASSISTANT, 'invoice-1', {
          notes: 'x',
        } as never),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.serviceInvoice.update).not.toHaveBeenCalled();
    });

    it('reports an invoice from another clinic as not found', async () => {
      prisma.serviceInvoice.findFirst.mockResolvedValue(null);

      await expect(
        service.updateInvoice(CLINIC, OWNER, 'foreign', {
          notes: 'x',
        } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it('records the edit in the event trail', async () => {
      await service.updateInvoice(CLINIC, OWNER, 'invoice-1', {
        notes: 'x',
      } as never);

      expect(
        prisma.fiscalInvoiceEvent.create.mock.calls[0][0].data,
      ).toMatchObject({ eventType: 'DRAFT_UPDATED' });
    });
  });

  // ── Summary ────────────────────────────────────────────────────────────────

  describe('the fiscal summary', () => {
    it('reports zero for every status the clinic has none of', async () => {
      const summary = await service.getSummary(CLINIC);

      expect(summary.counts[ServiceInvoiceStatus.DRAFT]).toBe(0);
      expect(Object.keys(summary.counts).sort()).toEqual(
        Object.values(ServiceInvoiceStatus).sort(),
      );
    });

    it('reports the counts the database grouped', async () => {
      prisma.serviceInvoice.groupBy.mockResolvedValue([
        { status: ServiceInvoiceStatus.DRAFT, _count: { _all: 4 } },
        { status: ServiceInvoiceStatus.SIMULATED, _count: { _all: 2 } },
      ]);

      const summary = await service.getSummary(CLINIC);

      expect(summary.counts[ServiceInvoiceStatus.DRAFT]).toBe(4);
      expect(summary.counts[ServiceInvoiceStatus.SIMULATED]).toBe(2);
    });

    it('totals the month excluding cancelled invoices', async () => {
      prisma.serviceInvoice.findMany.mockResolvedValue([
        { amountCents: 10_000 },
        { amountCents: 25_000 },
      ]);

      const summary = await service.getSummary(CLINIC);

      expect(summary.monthTotalCents).toBe(35_000);
      expect(
        prisma.serviceInvoice.findMany.mock.calls[0][0].where,
      ).toMatchObject({ status: { not: ServiceInvoiceStatus.CANCELED } });
    });

    it('flags a clinic that has not finished its fiscal setup', async () => {
      prisma.clinicFiscalProfile.findUnique.mockResolvedValue(null);

      const summary = await service.getSummary(CLINIC);

      expect(summary.configurationPending).toBe(true);
      expect(summary.providerMode).toBe('LOCAL');
    });

    it('never reports real issuing as available', async () => {
      const summary = await service.getSummary(CLINIC);

      expect(summary.realIssuingEnabled).toBe(false);
    });
  });

  // ── Appointments to invoice ────────────────────────────────────────────────

  describe('listing appointments to invoice', () => {
    it('excludes cancelled appointments and scopes to the clinic', async () => {
      await service.listAppointmentsForInvoice(CLINIC, {} as never);

      expect(prisma.appointment.findMany.mock.calls[0][0].where).toMatchObject({
        clinicId: CLINIC,
        status: { not: 'CANCELED' },
      });
    });

    it('filters by patient name, professional and payment status', async () => {
      await service.listAppointmentsForInvoice(CLINIC, {
        patient: '  maria ',
        profileId: 'profile-1',
        paymentStatus: 'PAID',
      } as never);

      expect(prisma.appointment.findMany.mock.calls[0][0].where).toMatchObject({
        patientName: { contains: 'maria', mode: 'insensitive' },
        profileId: 'profile-1',
        paymentStatus: 'PAID',
      });
    });

    it('ignores a blank patient filter', async () => {
      await service.listAppointmentsForInvoice(CLINIC, {
        patient: '   ',
      } as never);

      expect(
        prisma.appointment.findMany.mock.calls[0][0].where,
      ).not.toHaveProperty('patientName');
    });

    it('marks an appointment that already has a live invoice', async () => {
      prisma.appointment.findMany.mockResolvedValue([
        {
          id: APPOINTMENT,
          serviceInvoices: [{ id: 'invoice-9', status: 'DRAFT' }],
        },
      ]);

      const result = await service.listAppointmentsForInvoice(
        CLINIC,
        {} as never,
      );

      expect(result.data[0]).toMatchObject({
        hasActiveInvoice: true,
        activeInvoiceId: 'invoice-9',
      });
      // The join row is an implementation detail and must not reach the client.
      expect(result.data[0]).not.toHaveProperty('serviceInvoices');
    });

    it('marks one that has none', async () => {
      prisma.appointment.findMany.mockResolvedValue([
        { id: APPOINTMENT, serviceInvoices: [] },
      ]);

      const result = await service.listAppointmentsForInvoice(
        CLINIC,
        {} as never,
      );

      expect(result.data[0]).toMatchObject({
        hasActiveInvoice: false,
        activeInvoiceId: null,
      });
    });

    it('caps the page size', async () => {
      const result = await service.listAppointmentsForInvoice(CLINIC, {
        limit: 500,
      } as never);

      expect(result.limit).toBe(50);
    });

    it('falls back to sane paging for nonsense values', async () => {
      const result = await service.listAppointmentsForInvoice(CLINIC, {
        page: 0,
        limit: -3,
      } as never);

      expect(result).toMatchObject({ page: 1, limit: 20 });
    });
  });

  // ── The draft built from an appointment ────────────────────────────────────

  describe('the draft built from an appointment', () => {
    it('bills the amount actually paid', async () => {
      const result = await service.getAppointmentInvoiceDraft(
        CLINIC,
        APPOINTMENT,
      );

      expect(result.draft.amountCents).toBe(10_000);
    });

    it('falls back to the estimate when nothing has been paid', async () => {
      prisma.appointment.findFirst.mockResolvedValue(
        appointmentRow({ paidAmountCents: null }),
      );

      const result = await service.getAppointmentInvoiceDraft(
        CLINIC,
        APPOINTMENT,
      );

      expect(result.draft.amountCents).toBe(12_000);
    });

    it('bills zero rather than a negative or absent amount', async () => {
      prisma.appointment.findFirst.mockResolvedValue(
        appointmentRow({ paidAmountCents: null, estimatedAmountCents: null }),
      );

      const result = await service.getAppointmentInvoiceDraft(
        CLINIC,
        APPOINTMENT,
      );

      expect(result.draft.amountCents).toBe(0);
    });

    it('describes the service, or falls back to a generic description', async () => {
      prisma.appointment.findFirst.mockResolvedValue(
        appointmentRow({ service: null }),
      );

      const result = await service.getAppointmentInvoiceDraft(
        CLINIC,
        APPOINTMENT,
      );

      expect(result.draft.serviceDescription).toBe('Consulta odontológica');
      expect(result.appointment.serviceName).toBeNull();
    });

    it('uses the appointment date as the competence date', async () => {
      const result = await service.getAppointmentInvoiceDraft(
        CLINIC,
        APPOINTMENT,
      );

      expect(result.draft.competenceDate).toBe('2026-06-15');
    });

    it('warns when the appointment has not been paid', async () => {
      prisma.appointment.findFirst.mockResolvedValue(
        appointmentRow({ paymentStatus: 'PAYMENT_PENDING' }),
      );

      const result = await service.getAppointmentInvoiceDraft(
        CLINIC,
        APPOINTMENT,
      );

      expect(result.warnings.paymentPending).toBe(true);
    });

    it('warns when an invoice already exists for it', async () => {
      prisma.serviceInvoice.findFirst.mockResolvedValue({
        id: 'invoice-9',
        status: 'DRAFT',
      });

      const result = await service.getAppointmentInvoiceDraft(
        CLINIC,
        APPOINTMENT,
      );

      expect(result.warnings.hasExistingInvoice).toBe(true);
      expect(result.existingInvoice).toEqual({
        id: 'invoice-9',
        status: 'DRAFT',
      });
    });

    it('reports an appointment from another clinic as not found', async () => {
      prisma.appointment.findFirst.mockResolvedValue(null);

      await expect(
        service.getAppointmentInvoiceDraft(CLINIC, 'foreign'),
      ).rejects.toThrow(NotFoundException);
    });

    it('scopes the lookup to the caller’s clinic', async () => {
      await service.getAppointmentInvoiceDraft(CLINIC, APPOINTMENT);

      expect(prisma.appointment.findFirst.mock.calls[0][0].where).toEqual({
        id: APPOINTMENT,
        clinicId: CLINIC,
      });
    });
  });
});
