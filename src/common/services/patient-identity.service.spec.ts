import { ConflictException } from '@nestjs/common';
import { PatientIdentityService } from './patient-identity.service';

const CLINIC = 'clinic-1';

function createPrisma(phones: (string | null)[]) {
  return {
    appointment: {
      findMany: jest
        .fn()
        .mockResolvedValue(phones.map((patientPhone) => ({ patientPhone }))),
    },
  };
}

function createService(phones: (string | null)[]) {
  const prisma = createPrisma(phones);
  return {
    prisma,
    service: new PatientIdentityService(prisma as never),
  };
}

function createEmailService(names: string[]) {
  const prisma = {
    appointment: {
      findMany: jest
        .fn()
        .mockResolvedValue(names.map((patientName) => ({ patientName }))),
    },
  };
  return {
    prisma,
    service: new PatientIdentityService(prisma as never),
  };
}

describe('PatientIdentityService', () => {
  describe('email identifiers', () => {
    it('allows one person booked repeatedly under their own address', async () => {
      const { service } = createEmailService(['Maria Silva']);

      await expect(
        service.assertUnambiguousIdentity(CLINIC, 'maria@x.com'),
      ).resolves.toBeUndefined();
    });

    it('treats name spelling variants as the same person', async () => {
      const { service } = createEmailService(['Maria Silva', ' maria silva ']);

      await expect(
        service.countSharedEmailIdentityNames(CLINIC, 'maria@x.com'),
      ).resolves.toBe(1);
    });

    it('rejects a household that books two people under one address', async () => {
      // A parent booking themselves and a child on one shared email would
      // otherwise merge, and charting one would overwrite the other's chart.
      const { service } = createEmailService(['Marta Lima', 'Pedro Lima']);

      await expect(
        service.assertUnambiguousIdentity(CLINIC, 'familia@x.com'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('scopes the shared-address lookup to the clinic', async () => {
      const { service, prisma } = createEmailService(['Maria Silva']);

      await service.assertUnambiguousIdentity(CLINIC, ' Maria@X.COM ');

      expect(prisma.appointment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            clinicId: CLINIC,
            patientEmail: { equals: 'maria@x.com', mode: 'insensitive' },
          },
          distinct: ['patientName'],
          select: { patientName: true },
        }),
      );
    });

    it('reports no names for an address the clinic has never booked', async () => {
      const { service } = createEmailService([]);

      await expect(
        service.countSharedEmailIdentityNames(CLINIC, 'nobody@x.com'),
      ).resolves.toBe(0);
    });
  });

  describe('name-only identifiers', () => {
    it('allows a single patient recorded with one phone number', async () => {
      const { service } = createService(['(11) 99999-0000']);

      await expect(
        service.assertUnambiguousIdentity(CLINIC, 'Maria Silva'),
      ).resolves.toBeUndefined();
    });

    it('allows one patient whose phone was recorded with different masks', async () => {
      // "(11) 99999-0000" and "11999990000" are one person entered twice,
      // not two people — comparison must be on digits only.
      const { service } = createService(['(11) 99999-0000', '11999990000']);

      await expect(
        service.countNameOnlyIdentityPhones(CLINIC, 'Maria Silva'),
      ).resolves.toBe(1);
      await expect(
        service.assertUnambiguousIdentity(CLINIC, 'Maria Silva'),
      ).resolves.toBeUndefined();
    });

    it('rejects when two distinct phones share one name', async () => {
      // This is the cross-patient case: without the guard, one patient's
      // clinical record or dental chart would surface under the other's name.
      const { service } = createService(['11999990000', '11888880000']);

      await expect(
        service.assertUnambiguousIdentity(CLINIC, 'Maria Silva'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('scopes the ambiguity lookup to the clinic and the no-email branch', async () => {
      const { service, prisma } = createService(['11999990000']);

      await service.assertUnambiguousIdentity(CLINIC, ' Maria Silva ');

      expect(prisma.appointment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            clinicId: CLINIC,
            patientName: { equals: 'Maria Silva', mode: 'insensitive' },
            patientEmail: null,
          },
          distinct: ['patientPhone'],
          select: { patientPhone: true },
        }),
      );
    });

    it('ignores rows with a missing phone instead of counting them', async () => {
      const { service } = createService([null, '', '11999990000']);

      await expect(
        service.countNameOnlyIdentityPhones(CLINIC, 'Maria Silva'),
      ).resolves.toBe(1);
    });

    it('reports no phones for a name the clinic has never booked', async () => {
      const { service } = createService([]);

      await expect(
        service.countNameOnlyIdentityPhones(CLINIC, 'Maria Silva'),
      ).resolves.toBe(0);
    });

    it('treats a blank name as having no candidates', async () => {
      const { service, prisma } = createService(['11999990000']);

      await expect(
        service.countNameOnlyIdentityPhones(CLINIC, '   '),
      ).resolves.toBe(0);
      expect(prisma.appointment.findMany).not.toHaveBeenCalled();
    });
  });
});
