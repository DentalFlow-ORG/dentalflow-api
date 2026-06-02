import 'reflect-metadata';
import { HttpStatus } from '@nestjs/common';
import type { Response } from 'express';

import { AbnormalConsumptionCopilotController } from './abnormal-consumption-copilot.controller';
import type { AbnormalConsumptionCopilotResult } from './abnormal-consumption-copilot.service';
import type { AuthUser } from '../../common/types/auth-user.type';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockCopilotService = {
  getLatestAnalysis: jest.fn(),
  getCopilotSummary: jest.fn(),
};

const mockAccessPolicy = {
  assertOwnerOrAssistantAccess: jest.fn().mockReturnValue('clinic-1'),
};

const MOCK_USER = { id: 'user-1', clinicId: 'clinic-1' } as unknown as AuthUser;

// ── Response builder ───────────────────────────────────────────────────────────

function buildRes() {
  const jsonFn = jest.fn();
  const sendFn = jest.fn();
  const statusFn = jest
    .fn()
    .mockReturnValue({ json: jsonFn, send: sendFn });
  const res = { status: statusFn } as unknown as Response;
  return { res, statusFn, jsonFn, sendFn };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('AbnormalConsumptionCopilotController.getLatestCopilotSummary', () => {
  let controller: AbnormalConsumptionCopilotController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new AbnormalConsumptionCopilotController(
      mockCopilotService as never,
      mockAccessPolicy as never,
    );
  });

  it('sends 204 with no body when no latest analysis exists', async () => {
    mockCopilotService.getLatestAnalysis.mockResolvedValue(null);
    const { res, statusFn, sendFn, jsonFn } = buildRes();

    await controller.getLatestCopilotSummary(MOCK_USER, res);

    expect(statusFn).toHaveBeenCalledWith(HttpStatus.NO_CONTENT);
    expect(sendFn).toHaveBeenCalled();
    expect(jsonFn).not.toHaveBeenCalled();
  });

  it('sends 200 with analysis body when a latest analysis exists', async () => {
    const analysis: AbnormalConsumptionCopilotResult = {
      summary: 'Resumo persistido.',
      highlights: ['Item A com consumo elevado.'],
      recommendedActions: ['Verifique o produto A.'],
      generatedAt: new Date('2026-06-01T12:00:00Z').toISOString(),
      cached: true,
      source: 'CACHE',
    };
    mockCopilotService.getLatestAnalysis.mockResolvedValue(analysis);
    const { res, statusFn, jsonFn, sendFn } = buildRes();

    await controller.getLatestCopilotSummary(MOCK_USER, res);

    expect(statusFn).toHaveBeenCalledWith(HttpStatus.OK);
    expect(jsonFn).toHaveBeenCalledWith(analysis);
    expect(sendFn).not.toHaveBeenCalled();
  });

  it('does not send a second response — status() is called exactly once', async () => {
    mockCopilotService.getLatestAnalysis.mockResolvedValue(null);
    const { res, statusFn } = buildRes();

    await controller.getLatestCopilotSummary(MOCK_USER, res);

    expect(statusFn).toHaveBeenCalledTimes(1);
  });

  it('forwards the clinicId from accessPolicy to the service', async () => {
    mockAccessPolicy.assertOwnerOrAssistantAccess.mockReturnValue('clinic-abc');
    mockCopilotService.getLatestAnalysis.mockResolvedValue(null);
    const { res } = buildRes();

    await controller.getLatestCopilotSummary(MOCK_USER, res);

    expect(mockCopilotService.getLatestAnalysis).toHaveBeenCalledWith('clinic-abc');
  });
});
