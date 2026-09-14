import {
  AiAssistantAnalysisStatus,
  AiAssistantAnalysisType,
} from '@prisma/client';

import { AiAssistantAnalysisRepository } from './ai-assistant-analysis.repository';

/**
 * The store of AI analyses, including the failed ones.
 *
 * The error path is the reason this has a test. An analysis failure carries
 * whatever the provider said, and that string is the one place a prompt
 * fragment, a key or a stack trace could reach the database. It is capped at
 * 500 characters and written without content, and both of those are
 * deliberate rather than incidental.
 */

const CLINIC = 'clinic-1';
const USER = 'user-1';

describe('AiAssistantAnalysisRepository', () => {
  let prisma: {
    aiAssistantAnalysis: { findFirst: jest.Mock; create: jest.Mock };
  };
  let repository: AiAssistantAnalysisRepository;

  beforeEach(() => {
    prisma = {
      aiAssistantAnalysis: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'analysis-1' }),
      },
    };
    repository = new AiAssistantAnalysisRepository(prisma as never);
  });

  describe('findLatest', () => {
    it('returns the newest successful analysis for the clinic and type', async () => {
      await repository.findLatest(CLINIC, AiAssistantAnalysisType.FINANCE);

      expect(prisma.aiAssistantAnalysis.findFirst).toHaveBeenCalledWith({
        where: {
          clinicId: CLINIC,
          type: AiAssistantAnalysisType.FINANCE,
          status: AiAssistantAnalysisStatus.SUCCESS,
        },
        orderBy: { generatedAt: 'desc' },
      });
    });

    it('never surfaces a failed run as the latest analysis', async () => {
      await repository.findLatest(CLINIC, AiAssistantAnalysisType.INVENTORY);

      // Showing a clinic an ERROR row as if it were an analysis would present
      // an error message as advice.
      const where = prisma.aiAssistantAnalysis.findFirst.mock.calls[0][0]
        .where as { status: string };
      expect(where.status).toBe(AiAssistantAnalysisStatus.SUCCESS);
    });
  });

  describe('saveSuccess', () => {
    const payload = {
      clinicId: CLINIC,
      userId: USER,
      type: AiAssistantAnalysisType.FINANCE,
      content: { sections: [] },
      model: 'gpt-4o-mini',
      generatedAt: new Date('2026-06-15T10:00:00.000Z'),
      periodStart: new Date('2026-06-01T00:00:00.000Z'),
      periodEnd: new Date('2026-06-30T00:00:00.000Z'),
    };

    it('records the analysis against the clinic, the user and the model', async () => {
      await repository.saveSuccess(payload);

      expect(prisma.aiAssistantAnalysis.create.mock.calls[0][0].data).toEqual({
        clinicId: CLINIC,
        userId: USER,
        type: AiAssistantAnalysisType.FINANCE,
        status: AiAssistantAnalysisStatus.SUCCESS,
        content: { sections: [] },
        model: 'gpt-4o-mini',
        generatedAt: payload.generatedAt,
        periodStart: payload.periodStart,
        periodEnd: payload.periodEnd,
      });
    });

    it('accepts an analysis with no period, such as an inventory one', async () => {
      await repository.saveSuccess({
        ...payload,
        type: AiAssistantAnalysisType.INVENTORY,
        periodStart: null,
        periodEnd: null,
      });

      expect(
        prisma.aiAssistantAnalysis.create.mock.calls[0][0].data,
      ).toMatchObject({ periodStart: null, periodEnd: null });
    });
  });

  describe('saveError', () => {
    const payload = {
      clinicId: CLINIC,
      userId: USER,
      type: AiAssistantAnalysisType.FINANCE,
      model: 'gpt-4o-mini',
      errorMessage: 'Upstream timeout',
    };

    it('records the failure as an ERROR row', async () => {
      await repository.saveError(payload);

      expect(
        prisma.aiAssistantAnalysis.create.mock.calls[0][0].data,
      ).toMatchObject({
        clinicId: CLINIC,
        userId: USER,
        status: AiAssistantAnalysisStatus.ERROR,
        model: 'gpt-4o-mini',
        errorMessage: 'Upstream timeout',
      });
    });

    it('stores no content alongside the error', async () => {
      await repository.saveError(payload);

      // The content of a failed run is whatever the provider half-returned;
      // keeping it would persist an unvalidated payload.
      expect(
        prisma.aiAssistantAnalysis.create.mock.calls[0][0].data,
      ).not.toHaveProperty('content');
    });

    it('caps the message at 500 characters', async () => {
      await repository.saveError({
        ...payload,
        errorMessage: 'x'.repeat(5_000),
      });

      // An unbounded provider error is the one string that could carry a
      // prompt fragment or a stack trace into the database.
      const data = prisma.aiAssistantAnalysis.create.mock.calls[0][0].data as {
        errorMessage: string;
      };
      expect(data.errorMessage).toHaveLength(500);
    });

    it('stamps the failure with the time it happened', async () => {
      await repository.saveError(payload);

      const data = prisma.aiAssistantAnalysis.create.mock.calls[0][0].data as {
        generatedAt: Date;
      };
      expect(data.generatedAt).toBeInstanceOf(Date);
    });
  });
});
