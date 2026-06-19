import { ForbiddenException } from '@nestjs/common';

import { PlanCapabilitiesService } from './plan-capabilities.service';
import { PlanFeature } from './plan-feature.types';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const prismaMock = {
  subscription: { findUnique: jest.fn() },
  user: { count: jest.fn() },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildService(): PlanCapabilitiesService {
  return new PlanCapabilitiesService(prismaMock as never);
}

const CLINIC_ID = 'clinic-1';

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('PlanCapabilitiesService', () => {
  let service: PlanCapabilitiesService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = buildService();
  });

  describe('getPlanSlug', () => {
    it('returns the plan slug from the active subscription', async () => {
      prismaMock.subscription.findUnique.mockResolvedValue({ plan: { slug: 'professional' } });

      const slug = await service.getPlanSlug(CLINIC_ID);

      expect(slug).toBe('professional');
    });

    it('returns null when no subscription exists', async () => {
      prismaMock.subscription.findUnique.mockResolvedValue(null);

      const slug = await service.getPlanSlug(CLINIC_ID);

      expect(slug).toBeNull();
    });
  });

  describe('assertFeature', () => {
    it.each(['professional', 'premium'] as const)(
      'allows FINANCE feature for %s plan',
      async (planSlug) => {
        prismaMock.subscription.findUnique.mockResolvedValue({ plan: { slug: planSlug } });

        await expect(service.assertFeature(CLINIC_ID, PlanFeature.FINANCE)).resolves.toBeUndefined();
      },
    );

    it('allows all gated features available on professional plan', async () => {
      prismaMock.subscription.findUnique.mockResolvedValue({ plan: { slug: 'professional' } });

      // CLINICAL_DICTATION is premium-only — excluded here and tested separately below.
      const professionalFeatures = [
        PlanFeature.FINANCE,
        PlanFeature.INVENTORY,
        PlanFeature.FISCAL_CONTROL,
        PlanFeature.REPORTS,
        PlanFeature.GOOGLE_CALENDAR,
      ];

      for (const feature of professionalFeatures) {
        await expect(service.assertFeature(CLINIC_ID, feature)).resolves.toBeUndefined();
      }
    });

    it('denies CLINICAL_DICTATION for professional plan (premium-only feature)', async () => {
      prismaMock.subscription.findUnique.mockResolvedValue({ plan: { slug: 'professional' } });

      await expect(
        service.assertFeature(CLINIC_ID, PlanFeature.CLINICAL_DICTATION),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws ForbiddenException for starter plan (no gated features)', async () => {
      prismaMock.subscription.findUnique.mockResolvedValue({ plan: { slug: 'starter' } });

      await expect(service.assertFeature(CLINIC_ID, PlanFeature.FINANCE)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws ForbiddenException when no subscription exists (fail-safe)', async () => {
      prismaMock.subscription.findUnique.mockResolvedValue(null);

      await expect(service.assertFeature(CLINIC_ID, PlanFeature.REPORTS)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws ForbiddenException for unknown plan slug (fail-safe over fail-open)', async () => {
      prismaMock.subscription.findUnique.mockResolvedValue({ plan: { slug: 'enterprise_v2' } });

      await expect(service.assertFeature(CLINIC_ID, PlanFeature.INVENTORY)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('getUserLimitUsage', () => {
    it('returns correct limit, used and remaining seat counts', async () => {
      prismaMock.subscription.findUnique.mockResolvedValue({
        plan: { slug: 'professional', name: 'Professional', maxUsersPerClinic: 5 },
      });
      prismaMock.user.count.mockResolvedValue(3);

      const result = await service.getUserLimitUsage(CLINIC_ID);

      expect(result).toMatchObject({ limit: 5, used: 3, remaining: 2, planSlug: 'professional', planName: 'Professional' });
    });

    it('returns remaining of 0 when clinic is at capacity', async () => {
      prismaMock.subscription.findUnique.mockResolvedValue({
        plan: { slug: 'starter', name: 'Starter', maxUsersPerClinic: 2 },
      });
      prismaMock.user.count.mockResolvedValue(2);

      const result = await service.getUserLimitUsage(CLINIC_ID);

      expect(result).toMatchObject({ limit: 2, used: 2, remaining: 0 });
    });

    it('throws ForbiddenException when no plan is associated with the subscription', async () => {
      prismaMock.subscription.findUnique.mockResolvedValue(null);

      await expect(service.getUserLimitUsage(CLINIC_ID)).rejects.toThrow(ForbiddenException);
    });

    it('throws ForbiddenException when maxUsersPerClinic is zero or negative', async () => {
      prismaMock.subscription.findUnique.mockResolvedValue({
        plan: { slug: 'starter', name: 'Starter', maxUsersPerClinic: 0 },
      });

      await expect(service.getUserLimitUsage(CLINIC_ID)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('assertUserLimitAvailable', () => {
    it('resolves without throwing when seats are available', async () => {
      prismaMock.subscription.findUnique.mockResolvedValue({
        plan: { slug: 'professional', name: 'Professional', maxUsersPerClinic: 5 },
      });
      prismaMock.user.count.mockResolvedValue(2);

      await expect(service.assertUserLimitAvailable(CLINIC_ID)).resolves.toBeUndefined();
    });

    it('throws ForbiddenException when clinic is at user capacity', async () => {
      prismaMock.subscription.findUnique.mockResolvedValue({
        plan: { slug: 'starter', name: 'Starter', maxUsersPerClinic: 2 },
      });
      prismaMock.user.count.mockResolvedValue(2);

      await expect(service.assertUserLimitAvailable(CLINIC_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
