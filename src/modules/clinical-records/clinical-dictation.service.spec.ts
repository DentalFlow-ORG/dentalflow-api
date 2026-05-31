import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AiAssistantAnalysisType } from '@prisma/client';
import type OpenAI from 'openai';

import {
  CLINICAL_FIELD_KEYS,
  ClinicalDictationService,
} from './clinical-dictation.service';
import type { DictationResult } from './clinical-dictation.service';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockQuotaService = {
  assertQuota: jest.fn().mockResolvedValue(undefined),
};

const mockRepository = {
  saveSuccess: jest.fn().mockResolvedValue(undefined),
  saveError: jest.fn().mockResolvedValue(undefined),
};

const CLINIC_ID = 'clinic-1';
const USER_ID   = 'user-1';

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Shape used to replace the private `openai` property with controlled mocks.
 * Mirrors only the SDK surface used by ClinicalDictationService.
 */
type MockOpenAiShape = {
  audio: { transcriptions: { create: jest.Mock } };
  chat: { completions: { create: jest.Mock } };
};

const VALID_AUDIO_BASE64 = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEA';
const VALID_MIME = 'audio/webm';
const SAMPLE_TRANSCRIPT = 'Paciente relata dor no dente 36 há três dias, sensibilidade ao frio.';

function buildService(): ClinicalDictationService {
  return new ClinicalDictationService(mockQuotaService as never, mockRepository as never);
}

function buildDto(overrides: Partial<{ audioBase64: string; mimeType: string }> = {}) {
  return {
    audioBase64: VALID_AUDIO_BASE64,
    mimeType: VALID_MIME,
    ...overrides,
  };
}

/**
 * Replaces the service's `openai` property with mocks for both the transcription
 * and the chat-completion APIs. Follows the same pattern as ExpenseClassifierService tests.
 */
function mockOpenAi(
  service: ClinicalDictationService,
  transcriptionResponse: { text: string },
  classificationJson: string,
): void {
  (service as unknown as { openai: MockOpenAiShape }).openai = {
    audio: {
      transcriptions: {
        create: jest.fn().mockResolvedValue(transcriptionResponse),
      },
    },
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [{ message: { content: classificationJson } }],
        }),
      },
    },
  };
}

function getTranscriptionMock(service: ClinicalDictationService): jest.Mock {
  return (service as unknown as { openai: MockOpenAiShape }).openai.audio.transcriptions
    .create;
}

function getClassificationMock(service: ClinicalDictationService): jest.Mock {
  return (service as unknown as { openai: MockOpenAiShape }).openai.chat.completions.create;
}

/** Injects a mock that only covers transcription (chat is never expected to be called). */
function mockTranscriptionOnly(service: ClinicalDictationService, error: Error): void {
  (service as unknown as { openai: MockOpenAiShape }).openai = {
    audio: {
      transcriptions: { create: jest.fn().mockRejectedValue(error) },
    },
    chat: {
      completions: { create: jest.fn() },
    },
  };
}

/** Injects a mock where transcription succeeds and chat throws. */
function mockClassificationError(service: ClinicalDictationService, error: Error): void {
  (service as unknown as { openai: MockOpenAiShape }).openai = {
    audio: {
      transcriptions: {
        create: jest.fn().mockResolvedValue({ text: SAMPLE_TRANSCRIPT }),
      },
    },
    chat: {
      completions: { create: jest.fn().mockRejectedValue(error) },
    },
  };
}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('ClinicalDictationService', () => {
  let service: ClinicalDictationService;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENAI_API_KEY = 'sk-test';
    service = buildService();
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  // ── 1. Happy path ─────────────────────────────────────────────────────────

  it('returns transcript and whitelisted fields on a successful dictation', async () => {
    const classificationJson = JSON.stringify({
      fields: {
        chiefComplaint: 'Dor no dente 36',
        clinicalEvolution: 'Sensibilidade ao frio',
      },
    });
    mockOpenAi(service, { text: SAMPLE_TRANSCRIPT }, classificationJson);

    const result: DictationResult = await service.dictate(CLINIC_ID, USER_ID, buildDto());

    expect(result.transcript).toBe(SAMPLE_TRANSCRIPT);
    expect(result.fields.chiefComplaint).toBe('Dor no dente 36');
    expect(result.fields.clinicalEvolution).toBe('Sensibilidade ao frio');
    expect(getTranscriptionMock(service)).toHaveBeenCalledTimes(1);
    expect(getClassificationMock(service)).toHaveBeenCalledTimes(1);
  });

  // ── 2. Missing API key ────────────────────────────────────────────────────

  it('throws ServiceUnavailableException and does not call OpenAI when API key is missing', async () => {
    delete process.env.OPENAI_API_KEY;
    const svcWithoutKey = buildService();

    await expect(svcWithoutKey.dictate(CLINIC_ID, USER_ID, buildDto())).rejects.toThrow(
      ServiceUnavailableException,
    );

    // openai property is null — no SDK call can have been made
    const openaiProp = (svcWithoutKey as unknown as { openai: OpenAI | null }).openai;
    expect(openaiProp).toBeNull();
  });

  // ── 3. Whisper generic failure ────────────────────────────────────────────

  it('throws InternalServerErrorException on a generic Whisper error', async () => {
    mockTranscriptionOnly(service, new Error('Network error'));

    await expect(service.dictate(CLINIC_ID, USER_ID, buildDto())).rejects.toThrow(
      InternalServerErrorException,
    );
    // Classification is never reached
    expect(getClassificationMock(service)).not.toHaveBeenCalled();
  });

  // ── 4. Whisper rate limit ─────────────────────────────────────────────────

  it('throws ServiceUnavailableException on a Whisper 429 rate-limit error', async () => {
    const rateLimitErr = Object.assign(new Error('Rate limited'), { status: 429 });
    mockTranscriptionOnly(service, rateLimitErr);

    await expect(service.dictate(CLINIC_ID, USER_ID, buildDto())).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  // ── 5. GPT generic failure ────────────────────────────────────────────────

  it('throws InternalServerErrorException on a generic GPT classification error', async () => {
    mockClassificationError(service, new Error('GPT internal error'));

    await expect(service.dictate(CLINIC_ID, USER_ID, buildDto())).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(getTranscriptionMock(service)).toHaveBeenCalledTimes(1);
  });

  // ── 6. GPT rate limit ─────────────────────────────────────────────────────

  it('throws ServiceUnavailableException on a GPT 429 rate-limit error', async () => {
    const rateLimitErr = Object.assign(new Error('Rate limited'), { status: 429 });
    mockClassificationError(service, rateLimitErr);

    await expect(service.dictate(CLINIC_ID, USER_ID, buildDto())).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(getTranscriptionMock(service)).toHaveBeenCalledTimes(1);
  });

  // ── 7. Malformed GPT JSON ─────────────────────────────────────────────────

  it('throws InternalServerErrorException when GPT returns malformed JSON', async () => {
    mockOpenAi(service, { text: SAMPLE_TRANSCRIPT }, 'NOT VALID JSON {{{');

    await expect(service.dictate(CLINIC_ID, USER_ID, buildDto())).rejects.toThrow(
      InternalServerErrorException,
    );
  });

  // ── 8. Unknown GPT fields are stripped ───────────────────────────────────

  it('strips unknown fields and keeps only whitelisted clinical keys', async () => {
    const classificationJson = JSON.stringify({
      fields: {
        chiefComplaint: 'Dor de dente',
        unknownField: 'This should be stripped',
        patientId: 'Should also be stripped',
        diagnosis: 'Cárie no dente 36',
      },
    });
    mockOpenAi(service, { text: SAMPLE_TRANSCRIPT }, classificationJson);

    const result = await service.dictate(CLINIC_ID, USER_ID, buildDto());

    expect(result.fields).toHaveProperty('chiefComplaint');
    expect(result.fields).toHaveProperty('diagnosis');
    expect(result.fields).not.toHaveProperty('unknownField');
    expect(result.fields).not.toHaveProperty('patientId');

    // Confirm every returned key is in the whitelist
    for (const key of Object.keys(result.fields)) {
      expect(CLINICAL_FIELD_KEYS).toContain(key);
    }
  });

  // ── 9. Empty and non-string values are ignored ────────────────────────────

  it('ignores empty strings, whitespace-only strings, and non-string field values', async () => {
    const classificationJson = JSON.stringify({
      fields: {
        chiefComplaint: '',           // empty — must be excluded
        anamnesis: '   ',            // whitespace only — must be excluded
        clinicalEvolution: 42,        // number — must be excluded
        diagnosis: null,              // null — must be excluded
        prescription: false,          // boolean — must be excluded
        treatmentPlan: 'Tratamento válido',
      },
    });
    mockOpenAi(service, { text: SAMPLE_TRANSCRIPT }, classificationJson);

    const result = await service.dictate(CLINIC_ID, USER_ID, buildDto());

    expect(result.fields).not.toHaveProperty('chiefComplaint');
    expect(result.fields).not.toHaveProperty('anamnesis');
    expect(result.fields).not.toHaveProperty('clinicalEvolution');
    expect(result.fields).not.toHaveProperty('diagnosis');
    expect(result.fields).not.toHaveProperty('prescription');
    expect(result.fields).toHaveProperty('treatmentPlan', 'Tratamento válido');
  });

  // ── 10. No fields detected ────────────────────────────────────────────────

  it('returns transcript with empty fields object when GPT classifies no content', async () => {
    mockOpenAi(service, { text: SAMPLE_TRANSCRIPT }, JSON.stringify({ fields: {} }));

    const result = await service.dictate(CLINIC_ID, USER_ID, buildDto());

    expect(result.transcript).toBe(SAMPLE_TRANSCRIPT);
    expect(result.fields).toEqual({});
  });

  // ── 11. Long values are truncated ─────────────────────────────────────────

  it('truncates field values that exceed 2000 characters', async () => {
    const longText = 'A'.repeat(3000);
    mockOpenAi(
      service,
      { text: SAMPLE_TRANSCRIPT },
      JSON.stringify({ fields: { chiefComplaint: longText, diagnosis: longText } }),
    );

    const result = await service.dictate(CLINIC_ID, USER_ID, buildDto());

    expect(result.fields.chiefComplaint).toHaveLength(2000);
    expect(result.fields.diagnosis).toHaveLength(2000);
  });

  // ── 12. Global AI kill-switch ─────────────────────────────────────────────
  // Setting OPENAI_AI_ASSISTANT_ENABLED=false must disable dictation without
  // requiring the API key to be removed — matching every other AI service.

  it('throws ServiceUnavailableException and never calls quota or OpenAI when OPENAI_AI_ASSISTANT_ENABLED is "false"', async () => {
    process.env.OPENAI_AI_ASSISTANT_ENABLED = 'false';
    // Mock so we can verify neither quota nor OpenAI were called
    mockOpenAi(service, { text: SAMPLE_TRANSCRIPT }, JSON.stringify({ fields: {} }));

    await expect(service.dictate(CLINIC_ID, USER_ID, buildDto())).rejects.toThrow(
      ServiceUnavailableException,
    );

    // Kill-switch fires before quota check — no quota consumption
    expect(mockQuotaService.assertQuota).not.toHaveBeenCalled();
    expect(getTranscriptionMock(service)).not.toHaveBeenCalled();
    expect(getClassificationMock(service)).not.toHaveBeenCalled();

    delete process.env.OPENAI_AI_ASSISTANT_ENABLED;
  });

  // ── 13. Classification model follows OPENAI_MODEL env var ─────────────────

  it('passes OPENAI_MODEL env var as the GPT model for classification', async () => {
    process.env.OPENAI_MODEL = 'gpt-4o';
    const svc = new ClinicalDictationService(mockQuotaService as never, mockRepository as never);
    mockOpenAi(svc, { text: SAMPLE_TRANSCRIPT }, JSON.stringify({ fields: {} }));

    await svc.dictate(CLINIC_ID, USER_ID, buildDto());

    expect(getClassificationMock(svc)).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-4o' }),
    );

    delete process.env.OPENAI_MODEL;
  });

  // ── 14. Logging safety — transcript and audio are never logged ────────────
  // logSuccess must record only safe metadata: transcript length (not content),
  // field names (not values), model, and timing.

  it('logSuccess is called with transcript length — not transcript content or audio', async () => {
    mockOpenAi(
      service,
      { text: SAMPLE_TRANSCRIPT },
      JSON.stringify({ fields: { chiefComplaint: 'Dor' } }),
    );

    const logSuccessSpy = jest.spyOn(
      service as unknown as { logSuccess: (...args: unknown[]) => void },
      'logSuccess',
    );

    await service.dictate(CLINIC_ID, USER_ID, buildDto());

    expect(logSuccessSpy).toHaveBeenCalledTimes(1);
    const [transcriptLength, fieldNames, durationMs] = logSuccessSpy.mock.calls[0];

    // Only the length is logged — not the transcript text itself
    expect(transcriptLength).toBe(SAMPLE_TRANSCRIPT.length);
    expect(transcriptLength).not.toBe(SAMPLE_TRANSCRIPT);

    // Field names only — not their values
    expect(fieldNames).toEqual(['chiefComplaint']);

    // Timing is a number (no patient data)
    expect(typeof durationMs).toBe('number');
  });

  // ── 15. Quota enforcement ─────────────────────────────────────────────────

  it('calls assertQuota with the correct clinic and CLINICAL_DICTATION type before OpenAI', async () => {
    mockOpenAi(service, { text: SAMPLE_TRANSCRIPT }, JSON.stringify({ fields: {} }));

    await service.dictate(CLINIC_ID, USER_ID, buildDto());

    expect(mockQuotaService.assertQuota).toHaveBeenCalledWith(
      CLINIC_ID,
      AiAssistantAnalysisType.CLINICAL_DICTATION,
    );
    // assertQuota must be called before any OpenAI call
    const quotaCallOrder = mockQuotaService.assertQuota.mock.invocationCallOrder[0];
    const whisperCallOrder = getTranscriptionMock(service).mock.invocationCallOrder[0];
    expect(quotaCallOrder).toBeLessThan(whisperCallOrder);
  });

  it('throws ForbiddenException and never calls OpenAI when the plan does not allow dictation', async () => {
    mockQuotaService.assertQuota.mockRejectedValueOnce(
      new ForbiddenException('O assistente de IA não está disponível no seu plano atual.'),
    );
    mockOpenAi(service, { text: SAMPLE_TRANSCRIPT }, JSON.stringify({ fields: {} }));

    await expect(service.dictate(CLINIC_ID, USER_ID, buildDto())).rejects.toThrow(
      ForbiddenException,
    );

    expect(getTranscriptionMock(service)).not.toHaveBeenCalled();
    expect(getClassificationMock(service)).not.toHaveBeenCalled();
  });

  it('throws 429 and never calls OpenAI when the monthly quota is exhausted', async () => {
    mockQuotaService.assertQuota.mockRejectedValueOnce(
      new HttpException('Limite mensal de análises atingido.', HttpStatus.TOO_MANY_REQUESTS),
    );
    mockOpenAi(service, { text: SAMPLE_TRANSCRIPT }, JSON.stringify({ fields: {} }));

    await expect(service.dictate(CLINIC_ID, USER_ID, buildDto())).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });

    expect(getTranscriptionMock(service)).not.toHaveBeenCalled();
    expect(getClassificationMock(service)).not.toHaveBeenCalled();
  });

  it('calls repository.saveSuccess with safe metadata after a successful dictation', async () => {
    const classificationJson = JSON.stringify({ fields: { chiefComplaint: 'Dor' } });
    mockOpenAi(service, { text: SAMPLE_TRANSCRIPT }, classificationJson);

    await service.dictate(CLINIC_ID, USER_ID, buildDto());

    // Allow the fire-and-forget promise to settle
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(mockRepository.saveSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        clinicId:  CLINIC_ID,
        userId:    USER_ID,
        type:      AiAssistantAnalysisType.CLINICAL_DICTATION,
        content: {
          transcriptLength: SAMPLE_TRANSCRIPT.length,
          fieldsClassified: ['chiefComplaint'],
        },
        model:       expect.any(String),
        generatedAt: expect.any(Date),
        periodStart: null,
        periodEnd:   null,
      }),
    );

    // Confirm content does NOT include transcript text or field values
    const savedContent = mockRepository.saveSuccess.mock.calls[0][0].content as Record<string, unknown>;
    expect(Object.keys(savedContent)).not.toContain('transcript');
    expect(Object.keys(savedContent)).not.toContain('fields');
  });

  it('does not block the response when repository.saveSuccess fails', async () => {
    mockOpenAi(service, { text: SAMPLE_TRANSCRIPT }, JSON.stringify({ fields: {} }));
    mockRepository.saveSuccess.mockRejectedValueOnce(new Error('DB unavailable'));

    // Must resolve normally even when persistence fails
    await expect(service.dictate(CLINIC_ID, USER_ID, buildDto())).resolves.toMatchObject({
      transcript: SAMPLE_TRANSCRIPT,
    });
  });
});
