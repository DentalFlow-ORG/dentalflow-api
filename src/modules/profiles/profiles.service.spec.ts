import { ConflictException, NotFoundException } from '@nestjs/common';

import { ProfilesService } from './profiles.service';

const CLINIC_ID = 'clinic-1';
const PROFILE_ID = 'profile-1';
const SERVICE_ID = 'service-1';

const mockPrisma = {
  profile: { findFirst: jest.fn(), delete: jest.fn() },
  service: { findFirst: jest.fn(), delete: jest.fn() },
  appointment: { count: jest.fn() },
  financialTransaction: { count: jest.fn() },
  subscription: { findUnique: jest.fn() },
};

function profileRecord() {
  return { id: PROFILE_ID, clinicId: CLINIC_ID, userId: null, slug: 'test', isPublished: false };
}

function serviceRecord() {
  return { id: SERVICE_ID };
}

describe('ProfilesService.removeService', () => {
  let service: ProfilesService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ProfilesService(mockPrisma as never);
    mockPrisma.profile.findFirst.mockResolvedValue(profileRecord());
    mockPrisma.service.findFirst.mockResolvedValue(serviceRecord());
    mockPrisma.appointment.count.mockResolvedValue(0);
    mockPrisma.financialTransaction.count.mockResolvedValue(0);
  });

  it('throws ConflictException when appointments are linked to the service', async () => {
    mockPrisma.appointment.count.mockResolvedValue(1);

    await expect(
      service.removeService(CLINIC_ID, PROFILE_ID, SERVICE_ID),
    ).rejects.toThrow(ConflictException);
    expect(mockPrisma.service.delete).not.toHaveBeenCalled();
  });

  it('throws ConflictException when financial transactions are linked to the service', async () => {
    mockPrisma.financialTransaction.count.mockResolvedValue(2);

    await expect(
      service.removeService(CLINIC_ID, PROFILE_ID, SERVICE_ID),
    ).rejects.toThrow(ConflictException);
    expect(mockPrisma.service.delete).not.toHaveBeenCalled();
  });

  it('hard-deletes the service when no linked records exist', async () => {
    await service.removeService(CLINIC_ID, PROFILE_ID, SERVICE_ID);

    expect(mockPrisma.service.delete).toHaveBeenCalledWith({
      where: { id: SERVICE_ID },
    });
  });

  it('throws NotFoundException when service belongs to a different profile or clinic', async () => {
    mockPrisma.service.findFirst.mockResolvedValue(null);

    await expect(
      service.removeService(CLINIC_ID, PROFILE_ID, SERVICE_ID),
    ).rejects.toThrow(NotFoundException);
    expect(mockPrisma.service.delete).not.toHaveBeenCalled();
  });
});

describe('ProfilesService.remove', () => {
  let service: ProfilesService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ProfilesService(mockPrisma as never);
    mockPrisma.profile.findFirst.mockResolvedValue(profileRecord());
  });

  it('maps Prisma P2003 foreign-key error to ConflictException', async () => {
    const fkError = Object.assign(new Error('FK violation'), { code: 'P2003' });
    mockPrisma.profile.delete.mockRejectedValue(fkError);

    await expect(service.remove(CLINIC_ID, PROFILE_ID)).rejects.toThrow(
      ConflictException,
    );
  });

  it('hard-deletes the profile when no FK constraints are violated', async () => {
    mockPrisma.profile.delete.mockResolvedValue({ id: PROFILE_ID });

    await service.remove(CLINIC_ID, PROFILE_ID);

    expect(mockPrisma.profile.delete).toHaveBeenCalledWith({
      where: { id: PROFILE_ID },
    });
  });
});
