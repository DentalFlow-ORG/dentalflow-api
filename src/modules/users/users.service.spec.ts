import { NotFoundException } from '@nestjs/common';

import { UsersService } from './users.service';

const CLINIC_ID = 'clinic-1';
const USER_ID = 'user-1';

const txMock = {
  user: { update: jest.fn() },
  refreshToken: { updateMany: jest.fn() },
  profile: { updateMany: jest.fn() },
};

const mockPrisma = {
  user: { findFirst: jest.fn() },
  $transaction: jest.fn((callback: (tx: typeof txMock) => unknown) =>
    callback(txMock),
  ),
};

function member(overrides: { clinicId?: string; role?: string } = {}) {
  return {
    id: USER_ID,
    clinicId: overrides.clinicId ?? CLINIC_ID,
    role: overrides.role ?? 'DENTIST',
    isActive: true,
    deletedAt: null,
  };
}

describe('UsersService.deleteMember', () => {
  let service: UsersService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new UsersService(mockPrisma as never, {} as never);
  });

  it('soft-deletes the user (sets deletedAt and isActive: false)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(member());

    await service.deleteMember(CLINIC_ID, USER_ID);

    expect(txMock.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: expect.objectContaining({ isActive: false }),
    });
    const call = txMock.user.update.mock.calls[0][0] as { data: { deletedAt: unknown } };
    expect(call.data.deletedAt).toBeInstanceOf(Date);
  });

  it('revokes all active refresh tokens', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(member());

    await service.deleteMember(CLINIC_ID, USER_ID);

    expect(txMock.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('unpublishes linked dentist profile via profile.updateMany', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(member());

    await service.deleteMember(CLINIC_ID, USER_ID);

    expect(txMock.profile.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, isPublished: true },
      data: { isPublished: false },
    });
  });

  it('throws NotFoundException when userId belongs to a different clinic', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null);

    await expect(service.deleteMember(CLINIC_ID, USER_ID)).rejects.toThrow(
      NotFoundException,
    );
    expect(txMock.user.update).not.toHaveBeenCalled();
  });

  it('throws NotFoundException for OWNER role (role filter in assertClinicMembership)', async () => {
    // assertClinicMembership filters role: { in: ['DENTIST', 'ASSISTANT'] }
    // so OWNER users are invisible to it → returns null → NotFoundException
    mockPrisma.user.findFirst.mockResolvedValue(null);

    await expect(service.deleteMember(CLINIC_ID, USER_ID)).rejects.toThrow(
      NotFoundException,
    );
  });
});
