import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';

import { ProfilesService } from './profiles.service';

/**
 * Professional profiles and the services they offer.
 *
 * A profile is the clinic's public face: it carries a globally unique slug
 * that becomes a public URL, and publishing one exposes it to the internet.
 * Three rules follow, and each is covered here.
 *
 * Slugs are unique across the whole platform, not per clinic, so one clinic
 * cannot take a slug another already uses. Plan limits on profiles and
 * services are enforced before the write, not after. And a DENTIST may edit
 * only their own profile — an owner may edit any in their clinic.
 */

const CLINIC = 'clinic-1';
const PROFILE = 'profile-1';
const DENTIST_USER = 'dentist-1';

function profileRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROFILE,
    userId: DENTIST_USER,
    slug: 'dra-ana',
    isPublished: false,
    ...overrides,
  };
}

function createPrisma() {
  return {
    profile: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: PROFILE }),
      update: jest.fn().mockResolvedValue({ id: PROFILE }),
      delete: jest.fn().mockResolvedValue({ id: PROFILE }),
    },
    service: {
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'service-1' }),
      update: jest.fn().mockResolvedValue({ id: 'service-1' }),
      delete: jest.fn().mockResolvedValue({ id: 'service-1' }),
    },
    specialty: { findMany: jest.fn().mockResolvedValue([]) },
    profileSpecialty: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    subscription: { findUnique: jest.fn().mockResolvedValue(null) },
    appointment: { count: jest.fn().mockResolvedValue(0) },
    financialTransaction: { count: jest.fn().mockResolvedValue(0) },
    $transaction: jest.fn((cb: (tx: unknown) => unknown) =>
      typeof cb === 'function' ? cb(txClient) : Promise.resolve(cb),
    ),
  };
}

/** The transaction client `setSpecialties` writes through. */
let txClient: {
  profileSpecialty: {
    deleteMany: jest.Mock;
    createMany: jest.Mock;
  };
};

describe('ProfilesService', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let service: ProfilesService;

  beforeEach(() => {
    txClient = {
      profileSpecialty: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    prisma = createPrisma();
    service = new ProfilesService(prisma as never);
  });

  const dto = { displayName: 'Dra. Ana', slug: 'dra-ana' } as never;

  // ── Slug uniqueness ────────────────────────────────────────────────────────

  describe('slug uniqueness', () => {
    it('refuses a slug already in use anywhere on the platform', async () => {
      // Slugs are public URLs, so uniqueness is global rather than per clinic.
      prisma.profile.findUnique.mockResolvedValue({ id: 'someone-elses' });

      await expect(service.create(CLINIC, dto)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.profile.create).not.toHaveBeenCalled();
    });

    it('checks the slug without narrowing to the clinic', async () => {
      await service.create(CLINIC, dto);

      expect(prisma.profile.findUnique.mock.calls[0][0].where).toEqual({
        slug: 'dra-ana',
      });
    });

    it('re-checks the slug when an update changes it', async () => {
      prisma.profile.findFirst.mockResolvedValue(profileRow());

      await service.update(CLINIC, 'owner-1', UserRole.OWNER, PROFILE, {
        slug: 'novo-slug',
      } as never);

      expect(prisma.profile.findUnique).toHaveBeenCalled();
    });

    it('does not re-check when the slug is unchanged', async () => {
      prisma.profile.findFirst.mockResolvedValue(
        profileRow({ slug: 'dra-ana' }),
      );

      await service.update(CLINIC, 'owner-1', UserRole.OWNER, PROFILE, {
        slug: 'dra-ana',
      } as never);

      expect(prisma.profile.findUnique).not.toHaveBeenCalled();
    });
  });

  // ── Plan limits ────────────────────────────────────────────────────────────

  describe('plan limits', () => {
    it('allows unlimited profiles when the plan states no maximum', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        plan: { maxProfiles: null },
      });
      prisma.profile.count.mockResolvedValue(500);

      await expect(service.create(CLINIC, dto)).resolves.toBeDefined();
    });

    it('allows unlimited profiles when the clinic has no subscription row', async () => {
      prisma.profile.count.mockResolvedValue(500);

      await expect(service.create(CLINIC, dto)).resolves.toBeDefined();
    });

    it('refuses a profile once the plan maximum is reached', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        plan: { maxProfiles: 3 },
      });
      prisma.profile.count.mockResolvedValue(3);

      await expect(service.create(CLINIC, dto)).rejects.toThrow(
        /Limite de 3 perfis/,
      );
      expect(prisma.profile.create).not.toHaveBeenCalled();
    });

    it('allows a profile while below the maximum', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        plan: { maxProfiles: 3 },
      });
      prisma.profile.count.mockResolvedValue(2);

      await expect(service.create(CLINIC, dto)).resolves.toBeDefined();
    });

    it('checks the limit before the slug, so a full plan fails fast', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        plan: { maxProfiles: 1 },
      });
      prisma.profile.count.mockResolvedValue(1);

      await service.create(CLINIC, dto).catch(() => undefined);

      expect(prisma.profile.findUnique).not.toHaveBeenCalled();
    });

    it('counts profiles only within the clinic', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        plan: { maxProfiles: 3 },
      });

      await service.create(CLINIC, dto);

      expect(prisma.profile.count.mock.calls[0][0].where).toEqual({
        clinicId: CLINIC,
      });
    });

    it('refuses a service once the per-profile maximum is reached', async () => {
      prisma.profile.findFirst.mockResolvedValue(profileRow());
      prisma.subscription.findUnique.mockResolvedValue({
        plan: { maxServicesPerProfile: 5 },
      });
      prisma.service.count.mockResolvedValue(5);

      await expect(
        service.createService(CLINIC, PROFILE, { name: 'Limpeza' } as never),
      ).rejects.toThrow(/Limite de 5 serviços/);
    });

    it('counts services per profile, not per clinic', async () => {
      prisma.profile.findFirst.mockResolvedValue(profileRow());
      prisma.subscription.findUnique.mockResolvedValue({
        plan: { maxServicesPerProfile: 5 },
      });

      await service.createService(CLINIC, PROFILE, {
        name: 'Limpeza',
      } as never);

      expect(prisma.service.count.mock.calls[0][0].where).toEqual({
        profileId: PROFILE,
      });
    });
  });

  // ── Tenant and dentist scope ───────────────────────────────────────────────

  describe('scope', () => {
    it('scopes a profile lookup to the clinic', async () => {
      prisma.profile.findFirst.mockResolvedValue(profileRow());

      await service.findById(CLINIC, 'owner-1', UserRole.OWNER, PROFILE);

      expect(prisma.profile.findFirst.mock.calls[0][0].where).toMatchObject({
        id: PROFILE,
        clinicId: CLINIC,
      });
    });

    it('reports a profile from another clinic as not found', async () => {
      await expect(
        service.findById(CLINIC, 'owner-1', UserRole.OWNER, 'foreign'),
      ).rejects.toThrow(NotFoundException);
    });

    it('narrows the list to a dentist’s own profile', async () => {
      await service.findAll(CLINIC, DENTIST_USER, UserRole.DENTIST);

      expect(prisma.profile.findMany.mock.calls[0][0].where).toEqual({
        clinicId: CLINIC,
        userId: DENTIST_USER,
      });
    });

    it('shows an owner every profile in the clinic', async () => {
      await service.findAll(CLINIC, 'owner-1', UserRole.OWNER);

      expect(prisma.profile.findMany.mock.calls[0][0].where).toEqual({
        clinicId: CLINIC,
      });
    });

    it('refuses a dentist reading another professional’s profile', async () => {
      prisma.profile.findFirst.mockResolvedValue(
        profileRow({ userId: 'another-dentist' }),
      );

      await expect(
        service.findById(CLINIC, DENTIST_USER, UserRole.DENTIST, PROFILE),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lets a dentist read their own profile', async () => {
      prisma.profile.findFirst.mockResolvedValue(profileRow());

      await expect(
        service.findById(CLINIC, DENTIST_USER, UserRole.DENTIST, PROFILE),
      ).resolves.toBeDefined();
    });

    it('refuses a dentist updating another professional’s profile', async () => {
      prisma.profile.findFirst.mockResolvedValue(
        profileRow({ userId: 'another-dentist' }),
      );

      await expect(
        service.update(CLINIC, DENTIST_USER, UserRole.DENTIST, PROFILE, {
          displayName: 'x',
        } as never),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.profile.update).not.toHaveBeenCalled();
    });

    it('refuses a dentist setting another professional’s specialties', async () => {
      prisma.profile.findFirst.mockResolvedValue(
        profileRow({ userId: 'another-dentist' }),
      );

      await expect(
        service.setSpecialties(
          CLINIC,
          DENTIST_USER,
          UserRole.DENTIST,
          PROFILE,
          [],
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('lets an owner update any profile in the clinic', async () => {
      prisma.profile.findFirst.mockResolvedValue(
        profileRow({ userId: 'another-dentist' }),
      );

      await expect(
        service.update(CLINIC, 'owner-1', UserRole.OWNER, PROFILE, {
          displayName: 'x',
        } as never),
      ).resolves.toBeDefined();
    });
  });

  // ── Publishing ─────────────────────────────────────────────────────────────

  describe('publishing', () => {
    it('publishes an unpublished profile', async () => {
      prisma.profile.findFirst.mockResolvedValue(
        profileRow({ isPublished: false }),
      );

      await service.togglePublish(CLINIC, PROFILE);

      expect(prisma.profile.update.mock.calls[0][0].data).toEqual({
        isPublished: true,
      });
    });

    it('unpublishes a published profile', async () => {
      prisma.profile.findFirst.mockResolvedValue(
        profileRow({ isPublished: true }),
      );

      await service.togglePublish(CLINIC, PROFILE);

      expect(prisma.profile.update.mock.calls[0][0].data).toEqual({
        isPublished: false,
      });
    });

    it('refuses to publish a profile from another clinic', async () => {
      await expect(service.togglePublish(CLINIC, 'foreign')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── Public lookup by slug ──────────────────────────────────────────────────

  describe('findBySlug', () => {
    it('returns only a published profile', async () => {
      await service.findBySlug('dra-ana').catch(() => undefined);

      expect(prisma.profile.findUnique.mock.calls[0][0].where).toEqual({
        slug: 'dra-ana',
        isPublished: true,
      });
    });

    it('reports an unpublished or unknown slug as not found', async () => {
      await expect(service.findBySlug('nao-publicado')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('shows only active services on the public page', async () => {
      await service.findBySlug('dra-ana').catch(() => undefined);

      const include = prisma.profile.findUnique.mock.calls[0][0].include;
      expect(include.services.where).toEqual({ isActive: true });
    });
  });

  // ── Deletion ───────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('deletes a profile with no related records', async () => {
      prisma.profile.findFirst.mockResolvedValue(profileRow());

      await service.remove(CLINIC, PROFILE);

      expect(prisma.profile.delete).toHaveBeenCalledWith({
        where: { id: PROFILE },
      });
    });

    it('translates a foreign-key violation into a conflict, not a 500', async () => {
      // A profile with appointments cannot be deleted; the caller needs to
      // understand why rather than seeing an internal error.
      prisma.profile.findFirst.mockResolvedValue(profileRow());
      prisma.profile.delete.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('FK', {
          code: 'P2003',
          clientVersion: 'test',
        }),
      );

      await expect(service.remove(CLINIC, PROFILE)).rejects.toThrow(
        ConflictException,
      );
    });

    it('lets an unrelated failure surface unchanged', async () => {
      prisma.profile.findFirst.mockResolvedValue(profileRow());
      prisma.profile.delete.mockRejectedValue(new Error('connection lost'));

      await expect(service.remove(CLINIC, PROFILE)).rejects.toThrow(
        'connection lost',
      );
    });

    it('refuses to delete a profile from another clinic', async () => {
      await expect(service.remove(CLINIC, 'foreign')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.profile.delete).not.toHaveBeenCalled();
    });
  });

  // ── Services ───────────────────────────────────────────────────────────────

  describe('services', () => {
    beforeEach(() => {
      prisma.profile.findFirst.mockResolvedValue(profileRow());
    });

    it('creates a service against the profile and clinic', async () => {
      await service.createService(CLINIC, PROFILE, {
        name: 'Limpeza',
      } as never);

      expect(prisma.service.create.mock.calls[0][0].data).toMatchObject({
        profileId: PROFILE,
        clinicId: CLINIC,
        name: 'Limpeza',
      });
    });

    it('refuses a duplicate display order within the profile', async () => {
      prisma.service.findFirst.mockResolvedValue({ id: 'existing' });

      await expect(
        service.createService(CLINIC, PROFILE, {
          name: 'Limpeza',
          displayOrder: 1,
        } as never),
      ).rejects.toThrow(/ordem de exibição/);
    });

    it('does not check display order when none is given', async () => {
      await service.createService(CLINIC, PROFILE, {
        name: 'Limpeza',
      } as never);

      expect(prisma.service.findFirst).not.toHaveBeenCalled();
    });

    it('lets a service keep its own display order on update', async () => {
      // The uniqueness check must exclude the row being edited, or saving a
      // service without changing its order would fail.
      prisma.service.findFirst
        .mockResolvedValueOnce({ id: 'service-1' })
        .mockResolvedValueOnce(null);

      await service.updateService(CLINIC, PROFILE, 'service-1', {
        displayOrder: 1,
      } as never);

      const orderCheck = prisma.service.findFirst.mock.calls[1][0].where;
      expect(orderCheck).toMatchObject({
        profileId: PROFILE,
        displayOrder: 1,
        id: { not: 'service-1' },
      });
    });

    it('refuses to update a service belonging to another profile', async () => {
      prisma.service.findFirst.mockResolvedValue(null);

      await expect(
        service.updateService(CLINIC, PROFILE, 'foreign-service', {
          name: 'x',
        } as never),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.service.update).not.toHaveBeenCalled();
    });

    it('refuses to delete a service that has appointments', async () => {
      prisma.service.findFirst.mockResolvedValue({ id: 'service-1' });
      prisma.appointment.count.mockResolvedValue(2);

      await expect(
        service.removeService(CLINIC, PROFILE, 'service-1'),
      ).rejects.toThrow(/registros vinculados/);
      expect(prisma.service.delete).not.toHaveBeenCalled();
    });

    it('refuses to delete a service that has financial transactions', async () => {
      prisma.service.findFirst.mockResolvedValue({ id: 'service-1' });
      prisma.financialTransaction.count.mockResolvedValue(1);

      await expect(
        service.removeService(CLINIC, PROFILE, 'service-1'),
      ).rejects.toThrow(/registros vinculados/);
    });

    it('deletes a service with no history', async () => {
      prisma.service.findFirst.mockResolvedValue({ id: 'service-1' });

      await service.removeService(CLINIC, PROFILE, 'service-1');

      expect(prisma.service.delete).toHaveBeenCalledWith({
        where: { id: 'service-1' },
      });
    });
  });

  // ── Specialties ────────────────────────────────────────────────────────────

  describe('setSpecialties', () => {
    beforeEach(() => {
      prisma.profile.findFirst.mockResolvedValue(profileRow());
    });

    it('refuses an unknown specialty rather than silently dropping it', async () => {
      prisma.specialty.findMany.mockResolvedValue([{ id: 'spec-1' }]);

      await expect(
        service.setSpecialties(CLINIC, 'owner-1', UserRole.OWNER, PROFILE, [
          'spec-1',
          'spec-ghost',
        ]),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('replaces the whole set atomically', async () => {
      // Clearing and re-inserting must not leave the profile briefly with no
      // specialties if the insert fails.
      prisma.specialty.findMany.mockResolvedValue([{ id: 'spec-1' }]);

      await service.setSpecialties(CLINIC, 'owner-1', UserRole.OWNER, PROFILE, [
        'spec-1',
      ]);

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(txClient.profileSpecialty.deleteMany).toHaveBeenCalledWith({
        where: { profileId: PROFILE },
      });
      expect(
        txClient.profileSpecialty.createMany.mock.calls[0][0].data,
      ).toEqual([{ profileId: PROFILE, specialtyId: 'spec-1' }]);
    });

    it('clears every specialty when given an empty list', async () => {
      await service.setSpecialties(
        CLINIC,
        'owner-1',
        UserRole.OWNER,
        PROFILE,
        [],
      );

      expect(txClient.profileSpecialty.deleteMany).toHaveBeenCalled();
      expect(txClient.profileSpecialty.createMany).not.toHaveBeenCalled();
    });

    it('does not validate an empty list against the specialty table', async () => {
      await service.setSpecialties(
        CLINIC,
        'owner-1',
        UserRole.OWNER,
        PROFILE,
        [],
      );

      expect(prisma.specialty.findMany).not.toHaveBeenCalled();
    });
  });
});
