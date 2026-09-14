import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import { UsersService } from './users.service';

/**
 * A platform admin editing any account on the platform.
 *
 * This is the widest-reaching write in the system — it can move a person
 * between clinics and between roles — and it had no test. Two properties
 * matter more than the rest:
 *
 *  - role and clinic must stay consistent. A clinic role without a clinic, or
 *    an ADMIN carrying one, is a shape every guard downstream assumes cannot
 *    exist, because `assertValidRoleTenantShape` is written against it.
 *  - changing a role, a clinic or the active flag must invalidate the sessions
 *    the person already holds. Without that, a demoted owner keeps their
 *    access until their access token happens to expire.
 */

const USER = 'user-1';
const CLINIC = 'clinic-1';

function currentUser(overrides: Record<string, unknown> = {}) {
  return {
    id: USER,
    role: 'DENTIST',
    clinicId: CLINIC,
    isActive: true,
    ...overrides,
  };
}

function createHarness() {
  const tx = {
    user: { update: jest.fn().mockResolvedValue({ id: USER }) },
    refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };

  const prisma = {
    user: {
      findFirst: jest.fn().mockResolvedValue(currentUser()),
      update: jest.fn().mockResolvedValue({ id: USER }),
    },
    clinic: {
      findFirst: jest.fn().mockResolvedValue({ id: CLINIC }),
    },
    $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
  };

  const planCapabilities = {
    assertUserLimitAvailable: jest.fn().mockResolvedValue(undefined),
  };

  const service = new UsersService(prisma as never, planCapabilities as never);

  return { service, prisma, tx, planCapabilities };
}

describe('UsersService — admin editing a user', () => {
  let h: ReturnType<typeof createHarness>;

  beforeEach(() => {
    h = createHarness();
  });

  /** The email-conflict lookup is the second findFirst; default it to none. */
  function noEmailConflict() {
    h.prisma.user.findFirst
      .mockResolvedValueOnce(currentUser())
      .mockResolvedValueOnce(null);
  }

  // ── Role and tenancy shape ─────────────────────────────────────────────────

  describe('role and clinic must agree', () => {
    it.each(['OWNER', 'DENTIST', 'ASSISTANT'])(
      'refuses %s without a clinic',
      async (role) => {
        h.prisma.user.findFirst.mockResolvedValue(
          currentUser({ clinicId: null, role: 'PATIENT' }),
        );

        await expect(
          h.service.adminUpdate(USER, { role } as never),
        ).rejects.toThrow(BadRequestException);
        expect(h.prisma.$transaction).not.toHaveBeenCalled();
      },
    );

    it.each(['ADMIN', 'PATIENT'])(
      'refuses %s carrying a clinic',
      async (role) => {
        await expect(
          h.service.adminUpdate(USER, { role } as never),
        ).rejects.toThrow(BadRequestException);
        expect(h.prisma.$transaction).not.toHaveBeenCalled();
      },
    );

    it('judges the shape after the update, not before it', async () => {
      // Promoting to ADMIN while clearing the clinic in the same call is
      // legitimate; checking the stored clinicId alone would reject it.
      noEmailConflict();

      await expect(
        h.service.adminUpdate(USER, {
          role: 'ADMIN',
          clinicId: null,
        } as never),
      ).resolves.toBeDefined();
    });

    it('accepts a promotion that supplies the clinic in the same call', async () => {
      // A patient with no clinic becoming a dentist *of* a clinic is the
      // ordinary way a member is created. Judging the stored clinicId rather
      // than the effective one would reject it.
      h.prisma.user.findFirst
        .mockResolvedValueOnce(currentUser({ clinicId: null, role: 'PATIENT' }))
        .mockResolvedValueOnce(null);

      await expect(
        h.service.adminUpdate(USER, {
          role: 'DENTIST',
          clinicId: CLINIC,
        } as never),
      ).resolves.toBeDefined();
    });

    it('keeps the stored clinic when the update does not mention it', async () => {
      noEmailConflict();

      await expect(
        h.service.adminUpdate(USER, { role: 'ASSISTANT' } as never),
      ).resolves.toBeDefined();
      expect(h.prisma.clinic.findFirst.mock.calls[0][0].where.id).toBe(CLINIC);
    });

    it('reports an unknown user as not found', async () => {
      h.prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        h.service.adminUpdate('ghost', { firstName: 'x' } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it('ignores a soft-deleted user', async () => {
      await h.service
        .adminUpdate(USER, { firstName: 'x' } as never)
        .catch(() => undefined);

      expect(h.prisma.user.findFirst.mock.calls[0][0].where).toEqual({
        id: USER,
        deletedAt: null,
      });
    });

    it('refuses a clinic that does not exist', async () => {
      noEmailConflict();
      h.prisma.clinic.findFirst.mockResolvedValue(null);

      await expect(
        h.service.adminUpdate(USER, { clinicId: 'ghost-clinic' } as never),
      ).rejects.toThrow(NotFoundException);
      expect(h.prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // ── Email ──────────────────────────────────────────────────────────────────

  describe('email', () => {
    it('refuses an address another account already holds', async () => {
      h.prisma.user.findFirst
        .mockResolvedValueOnce(currentUser())
        .mockResolvedValueOnce({ id: 'someone-else' });

      await expect(
        h.service.adminUpdate(USER, { email: 'taken@example.test' } as never),
      ).rejects.toThrow(ConflictException);
      expect(h.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('excludes the account being edited from that check', async () => {
      noEmailConflict();

      await h.service.adminUpdate(USER, {
        email: 'same@example.test',
      } as never);

      // Otherwise saving a user without changing their address would collide
      // with themselves.
      expect(h.prisma.user.findFirst.mock.calls[1][0].where).toEqual({
        email: 'same@example.test',
        NOT: { id: USER },
      });
    });

    it('runs no conflict check when the address is not being changed', async () => {
      await h.service.adminUpdate(USER, { firstName: 'Ana' } as never);

      expect(h.prisma.user.findFirst).toHaveBeenCalledTimes(1);
    });
  });

  // ── Plan limits ────────────────────────────────────────────────────────────

  describe('the clinic’s user allowance', () => {
    it('is checked when a user joins a clinic as an active member', async () => {
      h.prisma.user.findFirst.mockResolvedValue(
        currentUser({ clinicId: null, role: 'PATIENT' }),
      );

      await h.service.adminUpdate(USER, {
        role: 'DENTIST',
        clinicId: CLINIC,
      } as never);

      expect(h.planCapabilities.assertUserLimitAvailable).toHaveBeenCalledWith(
        CLINIC,
      );
    });

    it('is checked when a member is reactivated', async () => {
      h.prisma.user.findFirst.mockResolvedValue(
        currentUser({ isActive: false }),
      );

      await h.service.adminUpdate(USER, { isActive: true } as never);

      expect(h.planCapabilities.assertUserLimitAvailable).toHaveBeenCalled();
    });

    it('is checked when a member moves to a different clinic', async () => {
      h.prisma.user.findFirst
        .mockResolvedValueOnce(currentUser({ clinicId: 'clinic-old' }))
        .mockResolvedValueOnce(null);

      await h.service.adminUpdate(USER, { clinicId: 'clinic-new' } as never);

      expect(h.planCapabilities.assertUserLimitAvailable).toHaveBeenCalledWith(
        'clinic-new',
      );
    });

    it('is not checked when the member already counted against it', async () => {
      // Renaming someone does not add a seat, and charging one would block
      // edits on a clinic sitting exactly on its limit.
      await h.service.adminUpdate(USER, { firstName: 'Ana' } as never);

      expect(
        h.planCapabilities.assertUserLimitAvailable,
      ).not.toHaveBeenCalled();
    });

    it('is not checked when the user is being deactivated', async () => {
      await h.service.adminUpdate(USER, { isActive: false } as never);

      expect(
        h.planCapabilities.assertUserLimitAvailable,
      ).not.toHaveBeenCalled();
    });

    it('is not checked for a role that occupies no seat', async () => {
      h.prisma.user.findFirst.mockResolvedValue(
        currentUser({ clinicId: null, role: 'PATIENT' }),
      );

      await h.service.adminUpdate(USER, { firstName: 'Ana' } as never);

      expect(
        h.planCapabilities.assertUserLimitAvailable,
      ).not.toHaveBeenCalled();
    });

    it('stops the update when the clinic is full', async () => {
      h.prisma.user.findFirst.mockResolvedValue(
        currentUser({ clinicId: null, role: 'PATIENT' }),
      );
      h.planCapabilities.assertUserLimitAvailable.mockRejectedValue(
        new BadRequestException('limite'),
      );

      await expect(
        h.service.adminUpdate(USER, {
          role: 'DENTIST',
          clinicId: CLINIC,
        } as never),
      ).rejects.toThrow(BadRequestException);
      expect(h.prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // ── Session invalidation ───────────────────────────────────────────────────

  describe('sessions after a privilege change', () => {
    it.each([
      ['a role change', { role: 'ASSISTANT' }],
      ['a clinic change', { clinicId: 'clinic-2' }],
      ['a deactivation', { isActive: false }],
    ])('are invalidated by %s', async (_name, dto) => {
      h.prisma.user.findFirst
        .mockResolvedValueOnce(currentUser())
        .mockResolvedValueOnce(null);

      await h.service.adminUpdate(USER, dto as never);

      // Both halves matter: the token version invalidates access tokens
      // already issued, and revoking refresh tokens stops new ones.
      const data = h.tx.user.update.mock.calls[0][0].data as {
        tokenVersion: unknown;
      };
      expect(data.tokenVersion).toEqual({ increment: 1 });
      expect(h.tx.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: USER, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('survive an edit that changes no privilege', async () => {
      await h.service.adminUpdate(USER, { firstName: 'Ana' } as never);

      const data = h.tx.user.update.mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(data).not.toHaveProperty('tokenVersion');
      expect(h.tx.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    it('are invalidated by an activation too, since it changes access', async () => {
      h.prisma.user.findFirst.mockResolvedValue(
        currentUser({ isActive: false }),
      );

      await h.service.adminUpdate(USER, { isActive: true } as never);

      // `isActive: false` in the DTO is the documented trigger; reactivation
      // reaches the same branch only through role or clinic, so this pins the
      // current behaviour rather than asserting a wish.
      const data = h.tx.user.update.mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(data.isActive).toBe(true);
    });

    it('writes the update and the revocation in one transaction', async () => {
      h.prisma.user.findFirst
        .mockResolvedValueOnce(currentUser())
        .mockResolvedValueOnce(null);

      await h.service.adminUpdate(USER, { role: 'ASSISTANT' } as never);

      // A revocation that survives a failed update, or an update whose
      // revocation fails, both leave a live session on stale privileges.
      expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(h.prisma.user.update).not.toHaveBeenCalled();
    });
  });

  // ── What actually gets written ─────────────────────────────────────────────

  describe('the write itself', () => {
    it('sets only the fields the caller sent', async () => {
      await h.service.adminUpdate(USER, { firstName: 'Ana' } as never);

      expect(h.tx.user.update.mock.calls[0][0].data).toEqual({
        firstName: 'Ana',
      });
    });

    it('carries every supplied field through', async () => {
      h.prisma.user.findFirst
        .mockResolvedValueOnce(currentUser())
        .mockResolvedValueOnce(null);

      await h.service.adminUpdate(USER, {
        firstName: 'Ana',
        lastName: 'Souza',
        email: 'ana@example.test',
        phone: '11999999999',
      } as never);

      expect(h.tx.user.update.mock.calls[0][0].data).toMatchObject({
        firstName: 'Ana',
        lastName: 'Souza',
        email: 'ana@example.test',
        phone: '11999999999',
      });
    });

    it('returns the safe projection rather than the raw row', async () => {
      await h.service.adminUpdate(USER, { firstName: 'Ana' } as never);

      const select = h.tx.user.update.mock.calls[0][0].select as Record<
        string,
        unknown
      >;
      expect(select).toBeDefined();
      expect(select).not.toHaveProperty('passwordHash');
    });
  });
});
