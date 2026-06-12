import { BadRequestException } from '@nestjs/common';

import { FiscalService } from './fiscal.service';

const CLINIC_ID = 'clinic-1';
const USER = { id: 'user-1', role: 'OWNER' as const };

const mockPrisma = {
  user: { findFirst: jest.fn() },
  appointment: { findFirst: jest.fn() },
  serviceInvoice: { findFirst: jest.fn(), create: jest.fn() },
  clinicFiscalProfile: { findUnique: jest.fn() },
  fiscalInvoiceEvent: { create: jest.fn() },
};

const mockProvider = {};

function baseDto() {
  return {
    customerName: 'Maria Souza',
    customerDocument: '529.982.247-25',
    customerEmail: 'maria@example.com',
    customerPhone: '11999999999',
    serviceDescription: 'Limpeza',
    amountCents: 10_000,
    issRate: 5,
    competenceDate: '2026-06-01',
  };
}

describe('FiscalService.createInvoice — link tenant scoping', () => {
  let service: FiscalService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new FiscalService(mockPrisma as never, mockProvider as never);
  });

  it('rejects a patientId that is not an active PATIENT-role user', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null);

    await expect(
      service.createInvoice(CLINIC_ID, USER, {
        ...baseDto(),
        patientId: 'foreign-user',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'foreign-user',
          role: 'PATIENT',
          isActive: true,
          deletedAt: null,
        },
      }),
    );
    expect(mockPrisma.serviceInvoice.create).not.toHaveBeenCalled();
  });

  it('rejects an appointmentId that belongs to another clinic', async () => {
    mockPrisma.appointment.findFirst.mockResolvedValue(null);

    await expect(
      service.createInvoice(CLINIC_ID, USER, {
        ...baseDto(),
        appointmentId: 'other-clinic-appt',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(mockPrisma.appointment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'other-clinic-appt',
          clinicId: CLINIC_ID,
        },
      }),
    );
    expect(mockPrisma.serviceInvoice.create).not.toHaveBeenCalled();
  });

  it('creates the invoice when the linked patient is a valid PATIENT user', async () => {
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'patient-1' });
    mockPrisma.serviceInvoice.findFirst.mockResolvedValue(null);
    mockPrisma.clinicFiscalProfile.findUnique.mockResolvedValue(null);
    mockPrisma.serviceInvoice.create.mockResolvedValue({
      id: 'inv-1',
      status: 'DRAFT',
    });
    mockPrisma.fiscalInvoiceEvent.create.mockResolvedValue({});

    const result = await service.createInvoice(CLINIC_ID, USER, {
      ...baseDto(),
      patientId: 'patient-1',
    } as never);

    expect(result).toEqual({ id: 'inv-1', status: 'DRAFT' });
    expect(mockPrisma.serviceInvoice.create).toHaveBeenCalledTimes(1);
  });
});
