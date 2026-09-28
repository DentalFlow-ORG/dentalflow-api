import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';

/**
 * Clinic member management (OWNER) and platform user management (ADMIN).
 *
 * Two invariants carry the security weight here.
 *
 * Scope: an OWNER manages DENTIST and ASSISTANT accounts and nothing else.
 * `assertClinicMembership` filters on role as well as clinic, so an owner
 * cannot deactivate, delete or reset the password of a co-owner — and cannot
 * reach into another clinic at all. `UpdateUserDto` additionally constrains
 * `role` to DENTIST|ASSISTANT, so an owner cannot mint a second owner.
 *
 * Session invalidation: any change that alters what an account may do — role,
 * deactivation, deletion, a new password — must bump `tokenVersion` and revoke
 * outstanding refresh tokens in the same transaction. Otherwise a demoted or
 * dismissed user keeps their old access token until it expires.
 */

const CLINIC = 'clinic-1';
const OTHER_CLINIC = 'clinic-2';
const MEMBER = 'member-1';

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
}));

type Tx = ReturnType<typeof createTx>;

function createTx() {
  return {
    user: {
      create: jest.fn().mockResolvedValue({ id: MEMBER }),
      update: jest.fn().mockResolvedValue({}),
    },
    profile: {
      create: jest.fn().mockResolvedValue({ id: 'profile-1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    profileSpecialty: { createMany: jest.fn().mockResolvedValue({}) },
    refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };
}

function createPrisma(tx: Tx) {
  return {
    user: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue({ id: MEMBER }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'new-user' }),
    },
    profile: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    specialty: { findMany: jest.fn().mockResolvedValue([]) },
    clinic: { findFirst: jest.fn().mockResolvedValue({ id: CLINIC }) },
    $transaction: jest.fn((cb: (t: Tx) => unknown) => cb(tx)),
  };
}

describe('UsersService — member and platform user management', () => {
  let tx: Tx;
  let prisma: ReturnType<typeof createPrisma>;
  let planCapabilities: { assertUserLimitAvailable: jest.Mock };
  let service: UsersService;

  beforeEach(() => {
    tx = createTx();
    prisma = createPrisma(tx);
    planCapabilities = {
      assertUserLimitAvailable: jest.fn().mockResolvedValue(undefined),
    };
    service = new UsersService(prisma as never, planCapabilities as never);
  });

  /** A member the owner is allowed to manage. */
  function existingMember(overrides: Record<string, unknown> = {}) {
    prisma.user.findFirst.mockResolvedValue({
      id: MEMBER,
      isActive: true,
      ...overrides,
    });
  }

  // ── Scope of an OWNER's authority ──────────────────────────────────────────

  describe('scope', () => {
    it.each([
      ['updateMember', () => service.updateMember(CLINIC, MEMBER, {} as never)],
      ['deleteMember', () => service.deleteMember(CLINIC, MEMBER)],
      [
        'updateMemberPassword',
        () =>
          service.updateMemberPassword(CLINIC, MEMBER, {
            password: 'Str0ngPass!',
          } as never),
      ],
    ])('%s refuses a user outside the clinic', async (_name, call) => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(call()).rejects.toThrow(NotFoundException);
      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it('looks members up by clinic and role together, excluding deleted ones', async () => {
      existingMember();
      await service.deleteMember(CLINIC, MEMBER);

      expect(prisma.user.findFirst.mock.calls[0][0].where).toEqual({
        id: MEMBER,
        clinicId: CLINIC,
        role: { in: ['DENTIST', 'ASSISTANT'] },
        deletedAt: null,
      });
    });

    it('cannot reach an OWNER — the role filter excludes them', async () => {
      // The lookup simply will not match an OWNER row, so the service answers
      // 404 and an owner cannot deactivate a co-owner.
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(service.deleteMember(CLINIC, 'other-owner')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('answers 404 rather than 403 for a member of another clinic', async () => {
      // 403 would confirm the account exists.
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.updateMember(OTHER_CLINIC, MEMBER, {
          firstName: 'Novo',
        } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it.each(['DENTIST', 'ASSISTANT'])(
      'accepts %s as a settable role',
      async (role) => {
        const dto = plainToInstance(UpdateUserDto, { role });
        await expect(validate(dto)).resolves.toEqual([]);
      },
    );

    it.each(['OWNER', 'ADMIN', 'PATIENT'])(
      'rejects %s as a settable role, so an owner cannot mint another',
      async (role) => {
        const dto = plainToInstance(UpdateUserDto, { role });
        const errors = await validate(dto);

        expect(errors).not.toEqual([]);
        expect(errors[0].property).toBe('role');
      },
    );
  });

  // ── Session invalidation ───────────────────────────────────────────────────

  describe('session invalidation', () => {
    it('revokes tokens and bumps tokenVersion when a member is deactivated', async () => {
      existingMember();

      await service.updateMember(CLINIC, MEMBER, { isActive: false } as never);

      expect(tx.user.update.mock.calls[0][0].data.tokenVersion).toEqual({
        increment: 1,
      });
      expect(tx.refreshToken.updateMany.mock.calls[0][0].where).toEqual({
        userId: MEMBER,
        revokedAt: null,
      });
    });

    it('revokes tokens when a member’s role changes', async () => {
      existingMember();

      await service.updateMember(CLINIC, MEMBER, {
        role: 'ASSISTANT',
      } as never);

      expect(tx.user.update.mock.calls[0][0].data.tokenVersion).toEqual({
        increment: 1,
      });
      expect(tx.refreshToken.updateMany).toHaveBeenCalled();
    });

    it('leaves sessions alone for a harmless edit', async () => {
      existingMember();

      await service.updateMember(CLINIC, MEMBER, {
        firstName: 'Novo',
      } as never);

      expect(tx.user.update.mock.calls[0][0].data.tokenVersion).toBeUndefined();
      expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    it('leaves sessions alone when the form resends the unchanged role, status and e-mail', async () => {
      // Membership lookup and the post-update read return the stored member;
      // the e-mail uniqueness check in between finds no other account.
      const stored = {
        id: MEMBER,
        isActive: true,
        role: 'DENTIST',
        email: 'membro@clinica.com',
      };
      prisma.user.findFirst
        .mockResolvedValueOnce(stored)
        .mockResolvedValueOnce(null)
        .mockResolvedValue(stored);

      await service.updateMember(CLINIC, MEMBER, {
        firstName: 'Novo',
        role: 'DENTIST',
        isActive: true,
        email: 'membro@clinica.com',
      } as never);

      expect(tx.user.update.mock.calls[0][0].data.tokenVersion).toBeUndefined();
      expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    it('revokes tokens when a member’s login e-mail changes', async () => {
      prisma.user.findFirst
        // membership check, then the uniqueness check, then the re-read
        .mockResolvedValueOnce({
          id: MEMBER,
          isActive: true,
          email: 'old@example.test',
        })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: MEMBER });

      await service.updateMember(CLINIC, MEMBER, {
        email: 'new@example.test',
      } as never);

      expect(tx.user.update.mock.calls[0][0].data.tokenVersion).toEqual({
        increment: 1,
      });
      expect(tx.refreshToken.updateMany.mock.calls[0][0].where).toEqual({
        userId: MEMBER,
        revokedAt: null,
      });
    });

    it('keeps sessions when the e-mail sent is the one already stored', async () => {
      prisma.user.findFirst
        // membership check, then the uniqueness check, then the re-read
        .mockResolvedValueOnce({
          id: MEMBER,
          isActive: true,
          email: 'same@example.test',
        })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: MEMBER });

      await service.updateMember(CLINIC, MEMBER, {
        email: 'same@example.test',
      } as never);

      expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    it('clears the phone when null is sent, and leaves it alone when omitted', async () => {
      existingMember();

      await service.updateMember(CLINIC, MEMBER, { phone: null } as never);
      await service.updateMember(CLINIC, MEMBER, { firstName: 'Ana' } as never);

      expect(tx.user.update.mock.calls[0][0].data).toEqual({ phone: null });
      expect(tx.user.update.mock.calls[1][0].data).not.toHaveProperty('phone');
    });

    it('does not invalidate sessions merely because a member is reactivated', async () => {
      existingMember({ isActive: false });

      await service.updateMember(CLINIC, MEMBER, { isActive: true } as never);

      expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    it('revokes tokens and bumps tokenVersion on a password reset', async () => {
      existingMember();

      await service.updateMemberPassword(CLINIC, MEMBER, {
        password: 'Str0ngPass!',
      } as never);

      expect(tx.user.update.mock.calls[0][0].data).toMatchObject({
        passwordHash: 'hashed-password',
        tokenVersion: { increment: 1 },
      });
      expect(tx.refreshToken.updateMany).toHaveBeenCalled();
    });

    it('performs the password change and the revocation in one transaction', async () => {
      existingMember();

      await service.updateMemberPassword(CLINIC, MEMBER, {
        password: 'Str0ngPass!',
      } as never);

      // Both writes went through the transaction client, not the root client.
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(tx.user.update).toHaveBeenCalled();
      expect(tx.refreshToken.updateMany).toHaveBeenCalled();
    });

    it('never stores a password in plain text', async () => {
      existingMember();

      await service.updateMemberPassword(CLINIC, MEMBER, {
        password: 'Str0ngPass!',
      } as never);

      const serialized = JSON.stringify(tx.user.update.mock.calls[0][0]);
      expect(serialized).not.toContain('Str0ngPass!');
    });
  });

  // ── Deletion ───────────────────────────────────────────────────────────────

  describe('deleteMember', () => {
    it('soft-deletes and deactivates rather than removing the row', async () => {
      existingMember();

      await service.deleteMember(CLINIC, MEMBER);

      expect(tx.user.update.mock.calls[0][0].data).toMatchObject({
        isActive: false,
        deletedAt: expect.any(Date) as unknown as Date,
      });
    });

    it('logs the member out immediately', async () => {
      existingMember();

      await service.deleteMember(CLINIC, MEMBER);

      expect(tx.refreshToken.updateMany.mock.calls[0][0].where).toEqual({
        userId: MEMBER,
        revokedAt: null,
      });
    });

    it('unpublishes the dentist’s public profile so it stops being advertised', async () => {
      existingMember();

      await service.deleteMember(CLINIC, MEMBER);

      expect(tx.profile.updateMany.mock.calls[0][0]).toEqual({
        where: { userId: MEMBER, isPublished: true },
        data: { isPublished: false },
      });
    });
  });

  // ── Creating a member ──────────────────────────────────────────────────────

  describe('createMember', () => {
    const dto = {
      email: 'novo@example.test',
      password: 'Str0ngPass!',
      firstName: 'Ana',
      lastName: 'Souza',
      role: 'ASSISTANT',
      phone: '11999998888',
    } as never;

    it('checks the plan seat limit before anything else', async () => {
      await service.createMember(CLINIC, dto);
      expect(planCapabilities.assertUserLimitAvailable).toHaveBeenCalledWith(
        CLINIC,
      );
    });

    it('refuses an email already in use anywhere on the platform', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'someone' });

      await expect(service.createMember(CLINIC, dto)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('creates the member inside the caller’s clinic, never another', async () => {
      await service.createMember(CLINIC, dto);
      expect(tx.user.create.mock.calls[0][0].data.clinicId).toBe(CLINIC);
    });

    it('stores only a hash of the password', async () => {
      await service.createMember(CLINIC, dto);

      expect(tx.user.create.mock.calls[0][0].data.passwordHash).toBe(
        'hashed-password',
      );
      expect(JSON.stringify(tx.user.create.mock.calls[0][0])).not.toContain(
        'Str0ngPass!',
      );
    });

    it('creates no profile for a non-dentist', async () => {
      await service.createMember(CLINIC, dto);
      expect(tx.profile.create).not.toHaveBeenCalled();
    });

    it('creates a linked profile for a dentist', async () => {
      await service.createMember(CLINIC, {
        ...(dto as object),
        role: 'DENTIST',
      } as never);

      expect(tx.profile.create.mock.calls[0][0].data).toMatchObject({
        clinicId: CLINIC,
        userId: MEMBER,
        displayName: 'Ana Souza',
      });
    });

    it('derives a slug from the display name when none is given', async () => {
      await service.createMember(CLINIC, {
        ...(dto as object),
        role: 'DENTIST',
      } as never);

      expect(tx.profile.create.mock.calls[0][0].data.slug).toBe('ana-souza');
    });

    it('prefers an explicit display name over the person’s name', async () => {
      await service.createMember(CLINIC, {
        ...(dto as object),
        role: 'DENTIST',
        displayName: '  Dra. Ana Souza  ',
      } as never);

      expect(tx.profile.create.mock.calls[0][0].data.displayName).toBe(
        'Dra. Ana Souza',
      );
    });

    it('refuses a slug already taken by another profile', async () => {
      prisma.profile.findUnique.mockResolvedValue({ id: 'existing-profile' });

      await expect(
        service.createMember(CLINIC, {
          ...(dto as object),
          role: 'DENTIST',
        } as never),
      ).rejects.toThrow(/already taken/);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('refuses unknown specialties rather than silently dropping them', async () => {
      prisma.specialty.findMany.mockResolvedValue([{ id: 'spec-1' }]);

      await expect(
        service.createMember(CLINIC, {
          ...(dto as object),
          role: 'DENTIST',
          specialtyIds: ['spec-1', 'spec-ghost'],
        } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('links the requested specialties when they all exist', async () => {
      prisma.specialty.findMany.mockResolvedValue([
        { id: 'spec-1' },
        { id: 'spec-2' },
      ]);

      await service.createMember(CLINIC, {
        ...(dto as object),
        role: 'DENTIST',
        specialtyIds: ['spec-1', 'spec-2'],
      } as never);

      expect(tx.profileSpecialty.createMany.mock.calls[0][0]).toMatchObject({
        data: [
          { profileId: 'profile-1', specialtyId: 'spec-1' },
          { profileId: 'profile-1', specialtyId: 'spec-2' },
        ],
        skipDuplicates: true,
      });
    });

    it('creates the user and the profile in one transaction', async () => {
      await service.createMember(CLINIC, {
        ...(dto as object),
        role: 'DENTIST',
      } as never);

      // A failure after the user row would otherwise leave a dentist with no
      // profile and no way to be scheduled.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.user.create).toHaveBeenCalled();
      expect(tx.profile.create).toHaveBeenCalled();
    });
  });

  // ── Email uniqueness on update ─────────────────────────────────────────────

  describe('updateMember email', () => {
    it('refuses an email belonging to someone else', async () => {
      prisma.user.findFirst
        .mockResolvedValueOnce({ id: MEMBER, isActive: true })
        .mockResolvedValueOnce({ id: 'someone-else' });

      await expect(
        service.updateMember(CLINIC, MEMBER, {
          email: 'taken@example.test',
        } as never),
      ).rejects.toThrow(ConflictException);
    });

    it('allows a member to keep their own email', async () => {
      prisma.user.findFirst
        // membership check, then the uniqueness check, then the re-read
        .mockResolvedValueOnce({ id: MEMBER, isActive: true })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: MEMBER, email: 'mine@example.test' });

      await expect(
        service.updateMember(CLINIC, MEMBER, {
          email: 'mine@example.test',
        } as never),
      ).resolves.toBeDefined();

      expect(prisma.user.findFirst.mock.calls[1][0].where).toMatchObject({
        email: 'mine@example.test',
        NOT: { id: MEMBER },
      });
    });

    it('re-checks the seat limit only when reactivating', async () => {
      existingMember({ isActive: false });

      await service.updateMember(CLINIC, MEMBER, { isActive: true } as never);
      expect(planCapabilities.assertUserLimitAvailable).toHaveBeenCalledWith(
        CLINIC,
      );
    });

    it('does not re-check the seat limit for an already-active member', async () => {
      existingMember({ isActive: true });

      await service.updateMember(CLINIC, MEMBER, { isActive: true } as never);
      expect(planCapabilities.assertUserLimitAvailable).not.toHaveBeenCalled();
    });
  });

  // ── ADMIN surface ──────────────────────────────────────────────────────────

  describe('admin user management', () => {
    it('never lists soft-deleted users', async () => {
      await service.adminFindAll();

      expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({
        deletedAt: null,
      });
      expect(prisma.user.count.mock.calls[0][0].where).toEqual({
        deletedAt: null,
      });
    });

    it('caps the page size at one hundred', async () => {
      const result = await service.adminFindAll(1, 5000);
      expect(result.limit).toBe(100);
      expect(prisma.user.findMany.mock.calls[0][0].take).toBe(100);
    });

    it('skips by the capped page size', async () => {
      await service.adminFindAll(3, 10);
      expect(prisma.user.findMany.mock.calls[0][0].skip).toBe(20);
    });

    it('never selects the password hash', async () => {
      await service.adminFindAll();

      const select = prisma.user.findMany.mock.calls[0][0].select;
      expect(select).not.toHaveProperty('passwordHash');
      expect(select).not.toHaveProperty('tokenVersion');
    });

    it('reports an unknown user as not found', async () => {
      await expect(service.adminFindById('ghost')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('requires a clinic for a clinic role', async () => {
      await expect(
        service.adminCreate({
          email: 'x@y.test',
          password: 'Str0ngPass!',
          firstName: 'A',
          lastName: 'B',
          role: 'DENTIST',
        } as never),
      ).rejects.toThrow(/clinicId is required/);
    });

    it.each(['ADMIN', 'PATIENT'])(
      'forbids a clinic for the %s role',
      async (role) => {
        await expect(
          service.adminCreate({
            email: 'x@y.test',
            password: 'Str0ngPass!',
            firstName: 'A',
            lastName: 'B',
            role,
            clinicId: CLINIC,
          } as never),
        ).rejects.toThrow(/deve ser omitido/);
      },
    );

    it('refuses a clinic that does not exist', async () => {
      prisma.clinic.findFirst.mockResolvedValue(null);

      await expect(
        service.adminCreate({
          email: 'x@y.test',
          password: 'Str0ngPass!',
          firstName: 'A',
          lastName: 'B',
          role: 'ASSISTANT',
          clinicId: 'ghost-clinic',
        } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it('refuses a soft-deleted clinic', async () => {
      await service
        .adminCreate({
          email: 'x@y.test',
          password: 'Str0ngPass!',
          firstName: 'A',
          lastName: 'B',
          role: 'ASSISTANT',
          clinicId: CLINIC,
        } as never)
        .catch(() => undefined);

      expect(prisma.clinic.findFirst.mock.calls[0][0].where).toEqual({
        id: CLINIC,
        deletedAt: null,
      });
    });

    it('counts a new clinic member against the plan seat limit', async () => {
      await service.adminCreate({
        email: 'x@y.test',
        password: 'Str0ngPass!',
        firstName: 'A',
        lastName: 'B',
        role: 'ASSISTANT',
        clinicId: CLINIC,
      } as never);

      expect(planCapabilities.assertUserLimitAvailable).toHaveBeenCalledWith(
        CLINIC,
      );
    });

    it('does not count a platform ADMIN against any clinic’s seats', async () => {
      await service.adminCreate({
        email: 'x@y.test',
        password: 'Str0ngPass!',
        firstName: 'A',
        lastName: 'B',
        role: 'ADMIN',
      } as never);

      expect(planCapabilities.assertUserLimitAvailable).not.toHaveBeenCalled();
      expect(prisma.user.create.mock.calls[0][0].data.clinicId).toBeNull();
    });

    it('soft-deletes and logs out a user it removes', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'u1' });

      await service.adminDelete('u1', 'admin-1');

      expect(tx.user.update.mock.calls[0][0].data).toMatchObject({
        isActive: false,
      });
      expect(tx.refreshToken.updateMany).toHaveBeenCalled();
    });

    it('refuses to let an admin remove their own account', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'admin-1' });

      await expect(service.adminDelete('admin-1', 'admin-1')).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('refuses to delete a user that does not exist', async () => {
      await expect(service.adminDelete('ghost', 'admin-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('invalidates every session on an admin password reset', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'u1' });

      await service.adminUpdatePassword('u1', {
        password: 'Str0ngPass!',
      } as never);

      expect(tx.user.update.mock.calls[0][0].data).toMatchObject({
        passwordHash: 'hashed-password',
        tokenVersion: { increment: 1 },
      });
      expect(tx.refreshToken.updateMany).toHaveBeenCalled();
    });

    it('refuses an admin password reset for an unknown user', async () => {
      await expect(
        service.adminUpdatePassword('ghost', {
          password: 'Str0ngPass!',
        } as never),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
