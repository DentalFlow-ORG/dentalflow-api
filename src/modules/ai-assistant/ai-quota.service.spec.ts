import { ForbiddenException, HttpStatus } from '@nestjs/common';
import { AiAssistantAnalysisType, SubscriptionStatus } from '@prisma/client';

import { AiQuotaService } from './ai-quota.service';
import {
  brazilCurrentIsoMonth,
  getBrazilMonthRange,
} from '../../common/utils/brazil-timezone';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const prismaMock = {
  subscription: { findFirst: jest.fn() },
  aiAssistantAnalysis: { count: jest.fn(), findFirst: jest.fn() },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildService(): AiQuotaService {
  return new AiQuotaService(prismaMock as never);
}

const CLINIC_ID = 'clinic-1';
const ANALYSIS_TYPE = AiAssistantAnalysisType.FINANCE;

function mockPlan(slug: string | null) {
  if (!slug) {
    prismaMock.subscription.findFirst.mockResolvedValue(null);
    return;
  }
  prismaMock.subscription.findFirst.mockResolvedValue({ plan: { slug } });
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('AiQuotaService', () => {
  let service: AiQuotaService;

  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.aiAssistantAnalysis.count.mockResolvedValue(0);
    prismaMock.aiAssistantAnalysis.findFirst.mockResolvedValue(null);
    service = buildService();
  });

  describe('getQuota — plan limits', () => {
    it('returns allowed:false for starter plan', async () => {
      mockPlan('starter');

      const result = await service.getQuota(CLINIC_ID, ANALYSIS_TYPE);

      expect(result).toMatchObject({ allowed: false, limit: 0, remaining: 0, planKey: 'starter' });
      expect(result.blockedReason).not.toBeNull();
    });

    it('returns allowed:true with remaining:1 for professional plan with 0 uses', async () => {
      mockPlan('professional');
      prismaMock.aiAssistantAnalysis.count.mockResolvedValue(0);

      const result = await service.getQuota(CLINIC_ID, ANALYSIS_TYPE);

      expect(result).toMatchObject({ allowed: true, limit: 1, used: 0, remaining: 1 });
      expect(result.blockedReason).toBeNull();
    });

    it('returns remaining:0 and sets blockedReason when professional quota is exhausted', async () => {
      mockPlan('professional');
      prismaMock.aiAssistantAnalysis.count.mockResolvedValue(1);

      const result = await service.getQuota(CLINIC_ID, ANALYSIS_TYPE);

      expect(result).toMatchObject({ allowed: true, remaining: 0, used: 1 });
      expect(result.blockedReason).not.toBeNull();
    });

    it('returns remaining:5 for premium plan with 5 uses this month', async () => {
      mockPlan('premium');
      prismaMock.aiAssistantAnalysis.count.mockResolvedValue(5);

      const result = await service.getQuota(CLINIC_ID, ANALYSIS_TYPE);

      expect(result).toMatchObject({ allowed: true, limit: 10, used: 5, remaining: 5 });
    });

    it('returns allowed:false when no active subscription exists', async () => {
      mockPlan(null);

      const result = await service.getQuota(CLINIC_ID, ANALYSIS_TYPE);

      expect(result).toMatchObject({ allowed: false, planKey: null });
    });

    it('returns allowed:false for unknown plan slug (fail-safe)', async () => {
      mockPlan('enterprise_v3');

      const result = await service.getQuota(CLINIC_ID, ANALYSIS_TYPE);

      expect(result).toMatchObject({ allowed: false, remaining: 0 });
    });
  });

  describe('getQuota — only counts ACTIVE and TRIALING subscriptions', () => {
    it('queries subscription.findFirst with ACTIVE and TRIALING status filter', async () => {
      mockPlan('professional');

      await service.getQuota(CLINIC_ID, ANALYSIS_TYPE);

      expect(prismaMock.subscription.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING] },
          }),
        }),
      );
    });
  });

  describe('getQuota — metadata fields', () => {
    it('returns nextResetAt as first day of the next Brazil month at UTC', async () => {
      mockPlan('professional');

      const result = await service.getQuota(CLINIC_ID, ANALYSIS_TYPE);

      const resetDate = new Date(result.nextResetAt);
      // Uses Brazil month boundaries: next reset = first day of next Brazil month
      // at Brazil midnight = UTC 03:00 of that date.
      const { end: expectedReset } = getBrazilMonthRange(brazilCurrentIsoMonth());

      expect(resetDate.toISOString()).toBe(expectedReset.toISOString());
    });

    it('returns lastGeneratedAt from the most recent success record', async () => {
      mockPlan('professional');
      const ts = new Date('2026-05-10T14:00:00.000Z');
      prismaMock.aiAssistantAnalysis.findFirst.mockResolvedValue({ generatedAt: ts });

      const result = await service.getQuota(CLINIC_ID, ANALYSIS_TYPE);

      expect(result.lastGeneratedAt).toBe(ts.toISOString());
    });

    it('returns null for lastGeneratedAt when no previous analysis exists', async () => {
      mockPlan('professional');
      prismaMock.aiAssistantAnalysis.findFirst.mockResolvedValue(null);

      const result = await service.getQuota(CLINIC_ID, ANALYSIS_TYPE);

      expect(result.lastGeneratedAt).toBeNull();
    });
  });

  describe('assertQuota', () => {
    it('resolves without throwing when quota is available', async () => {
      mockPlan('professional');
      prismaMock.aiAssistantAnalysis.count.mockResolvedValue(0);

      await expect(service.assertQuota(CLINIC_ID, ANALYSIS_TYPE)).resolves.toBeUndefined();
    });

    it('throws ForbiddenException when plan does not allow AI (starter)', async () => {
      mockPlan('starter');

      await expect(service.assertQuota(CLINIC_ID, ANALYSIS_TYPE)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws HTTP 429 when monthly quota is exhausted', async () => {
      mockPlan('professional');
      prismaMock.aiAssistantAnalysis.count.mockResolvedValue(1);

      try {
        await service.assertQuota(CLINIC_ID, ANALYSIS_TYPE);
        throw new Error('Expected exception not thrown');
      } catch (err: unknown) {
        expect((err as { getStatus?: () => number }).getStatus?.()).toBe(
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    });

    it('throws ForbiddenException when no active subscription exists', async () => {
      mockPlan(null);

      await expect(service.assertQuota(CLINIC_ID, ANALYSIS_TYPE)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
