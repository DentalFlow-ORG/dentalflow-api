import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AiAssistantAnalysisType } from '@prisma/client';
import type OpenAI from 'openai';

import {
  CLASSIFICATION_SYSTEM_PROMPT,
  CLINICAL_FIELD_KEYS,
  ClinicalDictationService,
  normalizeAudioMime,
  VALID_FDI_TOOTH_NUMBERS,
  VALID_ODONTOGRAM_CONDITIONS,
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
const USER_ID = 'user-1';

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
const SAMPLE_TRANSCRIPT =
  'Paciente relata dor no dente 36 há três dias, sensibilidade ao frio.';

function buildService(): ClinicalDictationService {
  return new ClinicalDictationService(
    mockQuotaService as never,
    mockRepository as never,
  );
}

function buildDto(
  overrides: Partial<{ audioBase64: string; mimeType: string }> = {},
) {
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
  return (service as unknown as { openai: MockOpenAiShape }).openai.audio
    .transcriptions.create;
}

function getClassificationMock(service: ClinicalDictationService): jest.Mock {
  return (service as unknown as { openai: MockOpenAiShape }).openai.chat
    .completions.create;
}

/** Injects a mock that only covers transcription (chat is never expected to be called). */
function mockTranscriptionOnly(
  service: ClinicalDictationService,
  error: Error,
): void {
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
function mockClassificationError(
  service: ClinicalDictationService,
  error: Error,
): void {
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

    const result: DictationResult = await service.dictate(
      CLINIC_ID,
      USER_ID,
      buildDto(),
    );

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

    await expect(
      svcWithoutKey.dictate(CLINIC_ID, USER_ID, buildDto()),
    ).rejects.toThrow(ServiceUnavailableException);

    // openai property is null — no SDK call can have been made
    const openaiProp = (svcWithoutKey as unknown as { openai: OpenAI | null })
      .openai;
    expect(openaiProp).toBeNull();
  });

  // ── 3. Whisper generic failure ────────────────────────────────────────────

  it('throws InternalServerErrorException on a generic Whisper error', async () => {
    mockTranscriptionOnly(service, new Error('Network error'));

    await expect(
      service.dictate(CLINIC_ID, USER_ID, buildDto()),
    ).rejects.toThrow(InternalServerErrorException);
    // Classification is never reached
    expect(getClassificationMock(service)).not.toHaveBeenCalled();
  });

  // ── 4. Whisper rate limit ─────────────────────────────────────────────────

  it('throws ServiceUnavailableException on a Whisper 429 rate-limit error', async () => {
    const rateLimitErr = Object.assign(new Error('Rate limited'), {
      status: 429,
    });
    mockTranscriptionOnly(service, rateLimitErr);

    await expect(
      service.dictate(CLINIC_ID, USER_ID, buildDto()),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  // ── 5. GPT generic failure ────────────────────────────────────────────────

  it('throws InternalServerErrorException on a generic GPT classification error', async () => {
    mockClassificationError(service, new Error('GPT internal error'));

    await expect(
      service.dictate(CLINIC_ID, USER_ID, buildDto()),
    ).rejects.toThrow(InternalServerErrorException);
    expect(getTranscriptionMock(service)).toHaveBeenCalledTimes(1);
  });

  // ── 6. GPT rate limit ─────────────────────────────────────────────────────

  it('throws ServiceUnavailableException on a GPT 429 rate-limit error', async () => {
    const rateLimitErr = Object.assign(new Error('Rate limited'), {
      status: 429,
    });
    mockClassificationError(service, rateLimitErr);

    await expect(
      service.dictate(CLINIC_ID, USER_ID, buildDto()),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(getTranscriptionMock(service)).toHaveBeenCalledTimes(1);
  });

  // ── 7. Malformed GPT JSON ─────────────────────────────────────────────────
  // GPT producing invalid JSON is a transient model reliability issue, not a
  // permanent code bug — the service throws ServiceUnavailableException (503)
  // so the frontend shows "temporariamente indisponível" and the user can retry.

  it('throws ServiceUnavailableException when GPT returns malformed JSON', async () => {
    mockOpenAi(service, { text: SAMPLE_TRANSCRIPT }, 'NOT VALID JSON {{{');

    await expect(
      service.dictate(CLINIC_ID, USER_ID, buildDto()),
    ).rejects.toThrow(ServiceUnavailableException);
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
        chiefComplaint: '', // empty — must be excluded
        anamnesis: '   ', // whitespace only — must be excluded
        clinicalEvolution: 42, // number — must be excluded
        diagnosis: null, // null — must be excluded
        prescription: false, // boolean — must be excluded
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
    mockOpenAi(
      service,
      { text: SAMPLE_TRANSCRIPT },
      JSON.stringify({ fields: {} }),
    );

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
      JSON.stringify({
        fields: { chiefComplaint: longText, diagnosis: longText },
      }),
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
    mockOpenAi(
      service,
      { text: SAMPLE_TRANSCRIPT },
      JSON.stringify({ fields: {} }),
    );

    await expect(
      service.dictate(CLINIC_ID, USER_ID, buildDto()),
    ).rejects.toThrow(ServiceUnavailableException);

    // Kill-switch fires before quota check — no quota consumption
    expect(mockQuotaService.assertQuota).not.toHaveBeenCalled();
    expect(getTranscriptionMock(service)).not.toHaveBeenCalled();
    expect(getClassificationMock(service)).not.toHaveBeenCalled();

    delete process.env.OPENAI_AI_ASSISTANT_ENABLED;
  });

  // ── 13. Classification model follows OPENAI_MODEL env var ─────────────────

  it('passes OPENAI_MODEL env var as the GPT model for classification', async () => {
    process.env.OPENAI_MODEL = 'gpt-4o';
    const svc = new ClinicalDictationService(
      mockQuotaService as never,
      mockRepository as never,
    );
    mockOpenAi(
      svc,
      { text: SAMPLE_TRANSCRIPT },
      JSON.stringify({ fields: {} }),
    );

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
    const [transcriptLength, fieldNames, durationMs] =
      logSuccessSpy.mock.calls[0];

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
    mockOpenAi(
      service,
      { text: SAMPLE_TRANSCRIPT },
      JSON.stringify({ fields: {} }),
    );

    await service.dictate(CLINIC_ID, USER_ID, buildDto());

    expect(mockQuotaService.assertQuota).toHaveBeenCalledWith(
      CLINIC_ID,
      AiAssistantAnalysisType.CLINICAL_DICTATION,
    );
    // assertQuota must be called before any OpenAI call
    const quotaCallOrder =
      mockQuotaService.assertQuota.mock.invocationCallOrder[0];
    const whisperCallOrder =
      getTranscriptionMock(service).mock.invocationCallOrder[0];
    expect(quotaCallOrder).toBeLessThan(whisperCallOrder);
  });

  it('throws ForbiddenException and never calls OpenAI when the plan does not allow dictation', async () => {
    mockQuotaService.assertQuota.mockRejectedValueOnce(
      new ForbiddenException(
        'O assistente de IA não está disponível no seu plano atual.',
      ),
    );
    mockOpenAi(
      service,
      { text: SAMPLE_TRANSCRIPT },
      JSON.stringify({ fields: {} }),
    );

    await expect(
      service.dictate(CLINIC_ID, USER_ID, buildDto()),
    ).rejects.toThrow(ForbiddenException);

    expect(getTranscriptionMock(service)).not.toHaveBeenCalled();
    expect(getClassificationMock(service)).not.toHaveBeenCalled();
  });

  it('throws 429 and never calls OpenAI when the monthly quota is exhausted', async () => {
    mockQuotaService.assertQuota.mockRejectedValueOnce(
      new HttpException(
        'Limite mensal de análises atingido.',
        HttpStatus.TOO_MANY_REQUESTS,
      ),
    );
    mockOpenAi(
      service,
      { text: SAMPLE_TRANSCRIPT },
      JSON.stringify({ fields: {} }),
    );

    await expect(
      service.dictate(CLINIC_ID, USER_ID, buildDto()),
    ).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });

    expect(getTranscriptionMock(service)).not.toHaveBeenCalled();
    expect(getClassificationMock(service)).not.toHaveBeenCalled();
  });

  it('calls repository.saveSuccess with safe metadata after a successful dictation', async () => {
    const classificationJson = JSON.stringify({
      fields: { chiefComplaint: 'Dor' },
    });
    mockOpenAi(service, { text: SAMPLE_TRANSCRIPT }, classificationJson);

    await service.dictate(CLINIC_ID, USER_ID, buildDto());

    // Allow the fire-and-forget promise to settle
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(mockRepository.saveSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        clinicId: CLINIC_ID,
        userId: USER_ID,
        type: AiAssistantAnalysisType.CLINICAL_DICTATION,
        content: {
          transcriptLength: SAMPLE_TRANSCRIPT.length,
          fieldsClassified: ['chiefComplaint'],
          odontogramSuggestionsCount: 0,
        },
        model: expect.any(String),
        generatedAt: expect.any(Date),
        periodStart: null,
        periodEnd: null,
      }),
    );

    // Confirm content does NOT include transcript text or field values
    const savedContent = mockRepository.saveSuccess.mock.calls[0][0]
      .content as Record<string, unknown>;
    expect(Object.keys(savedContent)).not.toContain('transcript');
    expect(Object.keys(savedContent)).not.toContain('fields');
  });

  it('does not block the response when repository.saveSuccess fails', async () => {
    mockOpenAi(
      service,
      { text: SAMPLE_TRANSCRIPT },
      JSON.stringify({ fields: {} }),
    );
    mockRepository.saveSuccess.mockRejectedValueOnce(
      new Error('DB unavailable'),
    );

    // Must resolve normally even when persistence fails
    await expect(
      service.dictate(CLINIC_ID, USER_ID, buildDto()),
    ).resolves.toMatchObject({
      transcript: SAMPLE_TRANSCRIPT,
    });
  });

  // ── 16. OpenAI HTTP error classification (transcription phase) ────────────
  // These tests cover the improved handleOpenAiError mapping that prevents
  // every non-429 OpenAI error from becoming a generic HTTP 500.

  it('throws BadRequestException when Whisper returns HTTP 400 (invalid/short audio)', async () => {
    const invalidAudioErr = Object.assign(new Error('invalid_request_error'), {
      status: 400,
    });
    mockTranscriptionOnly(service, invalidAudioErr);

    await expect(
      service.dictate(CLINIC_ID, USER_ID, buildDto()),
    ).rejects.toThrow(BadRequestException);
    // Classification must never be reached
    expect(getClassificationMock(service)).not.toHaveBeenCalled();
  });

  it('throws ServiceUnavailableException when Whisper returns HTTP 401 (bad API key)', async () => {
    const authErr = Object.assign(new Error('Incorrect API key provided'), {
      status: 401,
    });
    mockTranscriptionOnly(service, authErr);

    await expect(
      service.dictate(CLINIC_ID, USER_ID, buildDto()),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('throws ServiceUnavailableException when Whisper returns HTTP 500 (OpenAI server error)', async () => {
    const serverErr = Object.assign(new Error('Internal server error'), {
      status: 500,
    });
    mockTranscriptionOnly(service, serverErr);

    await expect(
      service.dictate(CLINIC_ID, USER_ID, buildDto()),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('throws ServiceUnavailableException when Whisper returns HTTP 503 (OpenAI outage)', async () => {
    const outageErr = Object.assign(new Error('Service unavailable'), {
      status: 503,
    });
    mockTranscriptionOnly(service, outageErr);

    await expect(
      service.dictate(CLINIC_ID, USER_ID, buildDto()),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  // ── 17. OpenAI HTTP error classification (classification phase) ───────────

  it('throws InternalServerErrorException when GPT returns HTTP 400 (malformed request)', async () => {
    // A 400 from the classification API indicates a code-level request error, not
    // invalid user audio — keep it as an internal error rather than BadRequest.
    const badReqErr = Object.assign(new Error('Bad request'), { status: 400 });
    mockClassificationError(service, badReqErr);

    await expect(
      service.dictate(CLINIC_ID, USER_ID, buildDto()),
    ).rejects.toThrow(InternalServerErrorException);
  });

  it('throws ServiceUnavailableException when GPT returns HTTP 503 (OpenAI outage)', async () => {
    const outageErr = Object.assign(new Error('Service unavailable'), {
      status: 503,
    });
    mockClassificationError(service, outageErr);

    await expect(
      service.dictate(CLINIC_ID, USER_ID, buildDto()),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  // ── 18. Logging safety for new error paths ────────────────────────────────

  it('does not log the transcript or audio data on a Whisper 400 error', async () => {
    const invalidAudioErr = Object.assign(new Error('audio_too_short'), {
      status: 400,
    });
    mockTranscriptionOnly(service, invalidAudioErr);

    const logSpy = jest.spyOn(
      (service as unknown as { logger: { error: jest.Mock } }).logger,
      'error',
    );

    await expect(
      service.dictate(CLINIC_ID, USER_ID, buildDto()),
    ).rejects.toThrow(BadRequestException);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const loggedPayload = JSON.parse(
      logSpy.mock.calls[0][0] as string,
    ) as Record<string, unknown>;

    // Logged payload must not contain transcript text or audio data
    expect(loggedPayload).not.toHaveProperty('transcript');
    expect(loggedPayload).not.toHaveProperty('audio');
    expect(loggedPayload).not.toHaveProperty('audioBase64');

    // Must log safe metadata only
    expect(loggedPayload.event).toBe('clinical_dictation_error');
    expect(loggedPayload.phase).toBe('transcription');
    expect(loggedPayload.errorCode).toBe('INVALID_AUDIO');
    expect(loggedPayload.httpStatus).toBe(400);
  });
});

// ── 17. normalizeAudioMime (pure function) ────────────────────────────────────
// Tests for the helper that strips codec parameters and maps MIME types to safe
// filenames for OpenAI Whisper.

describe('normalizeAudioMime', () => {
  // ── Codec param stripping ─────────────────────────────────────────────────

  it('strips codec parameter from audio/webm;codecs=opus → audio/webm + dictation.webm', () => {
    const result = normalizeAudioMime('audio/webm;codecs=opus');
    expect(result.mimeType).toBe('audio/webm');
    expect(result.filename).toBe('dictation.webm');
  });

  it('strips codec parameter from audio/ogg;codecs=opus → audio/ogg + dictation.ogg', () => {
    const result = normalizeAudioMime('audio/ogg;codecs=opus');
    expect(result.mimeType).toBe('audio/ogg');
    expect(result.filename).toBe('dictation.ogg');
  });

  // ── Plain MIME types pass through correctly ───────────────────────────────

  it('maps plain audio/webm to dictation.webm', () => {
    const result = normalizeAudioMime('audio/webm');
    expect(result.mimeType).toBe('audio/webm');
    expect(result.filename).toBe('dictation.webm');
  });

  it('maps audio/ogg to dictation.ogg', () => {
    const result = normalizeAudioMime('audio/ogg');
    expect(result.mimeType).toBe('audio/ogg');
    expect(result.filename).toBe('dictation.ogg');
  });

  it('maps audio/mp4 to dictation.mp4', () => {
    const result = normalizeAudioMime('audio/mp4');
    expect(result.mimeType).toBe('audio/mp4');
    expect(result.filename).toBe('dictation.mp4');
  });

  it('maps audio/mpeg to dictation.mp3 (Whisper-compatible extension)', () => {
    const result = normalizeAudioMime('audio/mpeg');
    expect(result.mimeType).toBe('audio/mpeg');
    expect(result.filename).toBe('dictation.mp3');
  });

  it('maps audio/wav to dictation.wav', () => {
    const result = normalizeAudioMime('audio/wav');
    expect(result.mimeType).toBe('audio/wav');
    expect(result.filename).toBe('dictation.wav');
  });

  // ── Case insensitivity ────────────────────────────────────────────────────

  it('handles upper-case MIME values', () => {
    const result = normalizeAudioMime('Audio/Webm');
    expect(result.mimeType).toBe('audio/webm');
    expect(result.filename).toBe('dictation.webm');
  });

  // ── Unsupported format → BadRequestException ──────────────────────────────

  it('throws BadRequestException for an unsupported MIME type', () => {
    expect(() => normalizeAudioMime('video/mp4')).toThrow(BadRequestException);
    expect(() => normalizeAudioMime('application/octet-stream')).toThrow(
      BadRequestException,
    );
  });
});

// ── 18. Audio normalization through the service ───────────────────────────────
// End-to-end coverage: confirm that when the service receives a MIME type with
// codec parameters, it sends a File with a clean extension to Whisper.

describe('audio normalization in transcription flow', () => {
  let service: ClinicalDictationService;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENAI_API_KEY = 'sk-test';
    service = new ClinicalDictationService(
      mockQuotaService as never,
      mockRepository as never,
    );
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it('passes a file with name "dictation.webm" when MIME is audio/webm;codecs=opus', async () => {
    mockOpenAi(service, { text: 'hello' }, JSON.stringify({ fields: {} }));
    const dto = {
      audioBase64: 'UklGRiQAAABXQVZFZm10IBAAAAABAAEA',
      mimeType: 'audio/webm;codecs=opus',
    };

    await service.dictate(CLINIC_ID, USER_ID, dto);

    const callArgs = getTranscriptionMock(service).mock.calls[0][0] as {
      file: File;
    };
    expect(callArgs.file.name).toBe('dictation.webm');
    expect(callArgs.file.type).toBe('audio/webm');
  });

  it('passes a file with name "dictation.ogg" when MIME is audio/ogg;codecs=opus', async () => {
    mockOpenAi(service, { text: 'hello' }, JSON.stringify({ fields: {} }));
    const dto = {
      audioBase64: 'UklGRiQAAABXQVZFZm10IBAAAAABAAEA',
      mimeType: 'audio/ogg;codecs=opus',
    };

    await service.dictate(CLINIC_ID, USER_ID, dto);

    const callArgs = getTranscriptionMock(service).mock.calls[0][0] as {
      file: File;
    };
    expect(callArgs.file.name).toBe('dictation.ogg');
    expect(callArgs.file.type).toBe('audio/ogg');
  });

  it('normalizes base64 that contains embedded whitespace/newlines', async () => {
    mockOpenAi(service, { text: 'hello' }, JSON.stringify({ fields: {} }));
    // Insert whitespace characters that must be stripped before Buffer.from
    const base64WithWhitespace = 'UklGRiQAAA BXQVZFZm10\nIBAAAAA\rBAAEA';
    const dto = { audioBase64: base64WithWhitespace, mimeType: 'audio/webm' };

    // Must succeed (no TypeError from Buffer.from with whitespace)
    await expect(
      service.dictate(CLINIC_ID, USER_ID, dto),
    ).resolves.toMatchObject({
      transcript: 'hello',
    });
  });

  it('strips an accidental data-URL prefix from audioBase64', async () => {
    mockOpenAi(service, { text: 'hello' }, JSON.stringify({ fields: {} }));
    const dataUrlBase64 =
      'data:audio/webm;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEA';
    const dto = { audioBase64: dataUrlBase64, mimeType: 'audio/webm' };

    // Must succeed without throwing a base64 parse error
    await expect(
      service.dictate(CLINIC_ID, USER_ID, dto),
    ).resolves.toMatchObject({
      transcript: 'hello',
    });
  });

  it('throws BadRequestException before calling OpenAI for an unsupported MIME type', async () => {
    mockOpenAi(service, { text: 'hello' }, JSON.stringify({ fields: {} }));
    const dto = {
      audioBase64: 'UklGRiQAAABXQVZFZm10IBAAAAABAAEA',
      mimeType: 'video/mp4',
    };

    await expect(service.dictate(CLINIC_ID, USER_ID, dto)).rejects.toThrow(
      BadRequestException,
    );

    // OpenAI must not have been called at all
    expect(getTranscriptionMock(service)).not.toHaveBeenCalled();
  });
});

// ── 19. Strict JSON mode (response_format) ────────────────────────────────────
// The classification call must always request json_object output mode so GPT
// is forced to return parseable JSON without prose commentary.

describe('strict JSON mode for classification', () => {
  let service: ClinicalDictationService;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENAI_API_KEY = 'sk-test';
    service = new ClinicalDictationService(
      mockQuotaService as never,
      mockRepository as never,
    );
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it('calls chat.completions.create with response_format: json_object', async () => {
    mockOpenAi(
      service,
      { text: SAMPLE_TRANSCRIPT },
      JSON.stringify({ fields: {} }),
    );

    await service.dictate(CLINIC_ID, USER_ID, buildDto());

    expect(getClassificationMock(service)).toHaveBeenCalledWith(
      expect.objectContaining({
        response_format: { type: 'json_object' },
      }),
    );
  });

  it('calls chat.completions.create with a low temperature for deterministic output', async () => {
    mockOpenAi(
      service,
      { text: SAMPLE_TRANSCRIPT },
      JSON.stringify({ fields: {} }),
    );

    await service.dictate(CLINIC_ID, USER_ID, buildDto());

    expect(getClassificationMock(service)).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: expect.any(Number) }),
    );
    const { temperature } = getClassificationMock(service).mock.calls[0][0] as {
      temperature: number;
    };
    expect(temperature).toBeLessThanOrEqual(0.2);
  });

  it('sends the transcript as the user message to the chat API', async () => {
    mockOpenAi(
      service,
      { text: SAMPLE_TRANSCRIPT },
      JSON.stringify({ fields: {} }),
    );

    await service.dictate(CLINIC_ID, USER_ID, buildDto());

    const { messages } = getClassificationMock(service).mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const userMessage = messages.find((m) => m.role === 'user');
    expect(userMessage?.content).toBe(SAMPLE_TRANSCRIPT);
  });
});

// ── 20. Classification system prompt properties ───────────────────────────────
// These tests verify the behavioral properties of the exported
// CLASSIFICATION_SYSTEM_PROMPT without snapshot-testing the full text.
// Purpose: catch accidental removals of critical instructions during edits.

describe('CLASSIFICATION_SYSTEM_PROMPT behavioral properties', () => {
  // ── Anti-hallucination rules ─────────────────────────────────────────────────

  it('instructs the model never to invent information not in the transcript', () => {
    // Must contain an explicit no-hallucination directive in Portuguese
    expect(CLASSIFICATION_SYSTEM_PROMPT).toMatch(/[Nn]unca invente/);
  });

  it('instructs the model to omit fields without clear transcript support', () => {
    expect(CLASSIFICATION_SYSTEM_PROMPT).toMatch(/[Oo]mita/);
  });

  // ── Portuguese clinical documentation style ──────────────────────────────────

  it('instructs the model to write in professional clinical Portuguese', () => {
    expect(CLASSIFICATION_SYSTEM_PROMPT).toMatch(/portugu[êe]s/i);
  });

  it('mentions FDI tooth numbering so tooth references are preserved', () => {
    expect(CLASSIFICATION_SYSTEM_PROMPT).toMatch(/FDI/);
  });

  // ── Allowed field catalogue ──────────────────────────────────────────────────

  it('lists every whitelisted clinical field key in the prompt', () => {
    for (const key of CLINICAL_FIELD_KEYS) {
      expect(CLASSIFICATION_SYSTEM_PROMPT).toContain(key);
    }
  });

  // ── JSON output format ───────────────────────────────────────────────────────

  it('instructs the model to return only valid JSON', () => {
    expect(CLASSIFICATION_SYSTEM_PROMPT).toMatch(/JSON/);
  });

  it('uses the {"fields": {...}} envelope shape in the format instruction', () => {
    expect(CLASSIFICATION_SYSTEM_PROMPT).toContain('"fields"');
  });

  // ── Log safety: prompt must be a static template with no embedded runtime data ─
  // Field examples ("Ex: Cárie no dente 36") are intentional placeholder text, not
  // real patient data. But the prompt must never contain the actual test transcripts
  // or any content that looks like it was injected at runtime.

  it('does not contain the sample transcript used in tests (static template only)', () => {
    // SAMPLE_TRANSCRIPT = 'Paciente relata dor no dente 36 há três dias, sensibilidade ao frio.'
    // The prompt must not accidentally embed any specific transcript content.
    expect(CLASSIFICATION_SYSTEM_PROMPT).not.toContain(
      'Paciente relata dor no dente 36',
    );
    expect(CLASSIFICATION_SYSTEM_PROMPT).not.toContain('Sensibilidade ao frio');
    expect(CLASSIFICATION_SYSTEM_PROMPT).not.toContain('sensibilidade ao frio');
  });

  it('includes odontogramSuggestions format in the prompt', () => {
    expect(CLASSIFICATION_SYSTEM_PROMPT).toContain('odontogramSuggestions');
    expect(CLASSIFICATION_SYSTEM_PROMPT).toContain('toothNumber');
    expect(CLASSIFICATION_SYSTEM_PROMPT).toContain('confidence');
  });
});

// ── 21. Odontogram suggestions extraction ────────────────────────────────────
// Tests for the new backend extraction of tooth-condition suggestions from GPT.

describe('odontogram suggestions extraction', () => {
  let service: ClinicalDictationService;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENAI_API_KEY = 'sk-test';
    service = new ClinicalDictationService(
      mockQuotaService as never,
      mockRepository as never,
    );
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  // ── Returns suggestions when GPT provides valid entries ───────────────────

  it('returns odontogram suggestions from GPT response alongside clinical fields', async () => {
    const classificationJson = JSON.stringify({
      fields: { chiefComplaint: 'Dor no dente 36' },
      odontogramSuggestions: [
        {
          toothNumber: '36',
          condition: 'caries',
          notes: 'Cárie relatada no ditado.',
          confidence: 'high',
          sourceText: 'dente 36 com cárie',
        },
      ],
    });
    mockOpenAi(service, { text: SAMPLE_TRANSCRIPT }, classificationJson);

    const result: DictationResult = await service.dictate(
      CLINIC_ID,
      USER_ID,
      buildDto(),
    );

    expect(result.odontogramSuggestions).toHaveLength(1);
    const s = result.odontogramSuggestions[0];
    expect(s.toothNumber).toBe('36');
    expect(s.condition).toBe('caries');
    expect(s.notes).toBe('Cárie relatada no ditado.');
    expect(s.confidence).toBe('high');
    expect(s.sourceText).toBe('dente 36 com cárie');
  });

  it('returns an empty odontogramSuggestions array when none are in the GPT response', async () => {
    mockOpenAi(
      service,
      { text: SAMPLE_TRANSCRIPT },
      JSON.stringify({ fields: {} }),
    );

    const result = await service.dictate(CLINIC_ID, USER_ID, buildDto());

    expect(result.odontogramSuggestions).toEqual([]);
  });

  it('returns an empty array when odontogramSuggestions key is absent', async () => {
    mockOpenAi(
      service,
      { text: SAMPLE_TRANSCRIPT },
      JSON.stringify({ fields: { chiefComplaint: 'Dor' } }),
    );

    const result = await service.dictate(CLINIC_ID, USER_ID, buildDto());

    expect(result.odontogramSuggestions).toEqual([]);
  });

  // ── Validation: invalid entries are silently dropped ─────────────────────

  it('strips suggestions with an invalid tooth number (not in FDI set)', async () => {
    const classificationJson = JSON.stringify({
      fields: {},
      odontogramSuggestions: [
        { toothNumber: '99', condition: 'caries' }, // 99 is not a valid FDI number
        { toothNumber: '36', condition: 'caries' }, // valid
      ],
    });
    mockOpenAi(service, { text: SAMPLE_TRANSCRIPT }, classificationJson);

    const result = await service.dictate(CLINIC_ID, USER_ID, buildDto());

    expect(result.odontogramSuggestions).toHaveLength(1);
    expect(result.odontogramSuggestions[0].toothNumber).toBe('36');
  });

  it('strips suggestions with an unknown condition value', async () => {
    const classificationJson = JSON.stringify({
      fields: {},
      odontogramSuggestions: [
        { toothNumber: '36', condition: 'unknown_condition' }, // invalid
        { toothNumber: '11', condition: 'crown' }, // valid
      ],
    });
    mockOpenAi(service, { text: SAMPLE_TRANSCRIPT }, classificationJson);

    const result = await service.dictate(CLINIC_ID, USER_ID, buildDto());

    expect(result.odontogramSuggestions).toHaveLength(1);
    expect(result.odontogramSuggestions[0].toothNumber).toBe('11');
    expect(result.odontogramSuggestions[0].condition).toBe('crown');
  });

  it('strips suggestions missing toothNumber or condition', async () => {
    const classificationJson = JSON.stringify({
      fields: {},
      odontogramSuggestions: [
        { condition: 'caries' }, // missing toothNumber
        { toothNumber: '36' }, // missing condition
        { toothNumber: '11', condition: 'healthy' }, // valid
      ],
    });
    mockOpenAi(service, { text: SAMPLE_TRANSCRIPT }, classificationJson);

    const result = await service.dictate(CLINIC_ID, USER_ID, buildDto());

    expect(result.odontogramSuggestions).toHaveLength(1);
    expect(result.odontogramSuggestions[0].toothNumber).toBe('11');
  });

  it('accepts all 13 valid odontogram conditions', async () => {
    const validConditions = [...VALID_ODONTOGRAM_CONDITIONS];
    // Use 13 valid FDI permanent tooth numbers (11-18 = 8, 21-25 = 5) to pair with each condition.
    const teethForTest = [
      '11',
      '12',
      '13',
      '14',
      '15',
      '16',
      '17',
      '18',
      '21',
      '22',
      '23',
      '24',
      '25',
    ];
    const suggestions = validConditions.map((condition, i) => ({
      toothNumber: teethForTest[i],
      condition,
    }));

    mockOpenAi(
      service,
      { text: SAMPLE_TRANSCRIPT },
      JSON.stringify({ fields: {}, odontogramSuggestions: suggestions }),
    );

    const result = await service.dictate(CLINIC_ID, USER_ID, buildDto());

    expect(result.odontogramSuggestions).toHaveLength(validConditions.length);
  });

  it('accepts valid FDI permanent and deciduous tooth numbers', async () => {
    const samples = ['11', '36', '48', '51', '75', '85']; // permanent + deciduous
    const suggestions = samples.map((toothNumber) => ({
      toothNumber,
      condition: 'caries',
    }));

    mockOpenAi(
      service,
      { text: SAMPLE_TRANSCRIPT },
      JSON.stringify({ fields: {}, odontogramSuggestions: suggestions }),
    );

    const result = await service.dictate(CLINIC_ID, USER_ID, buildDto());

    expect(result.odontogramSuggestions).toHaveLength(samples.length);
    const returnedTeeth = result.odontogramSuggestions.map(
      (s) => s.toothNumber,
    );
    for (const t of samples) expect(returnedTeeth).toContain(t);
  });

  it('normalizes condition to lowercase before validating', async () => {
    // GPT might return uppercase or mixed-case — normalize before validation
    const classificationJson = JSON.stringify({
      fields: {},
      odontogramSuggestions: [{ toothNumber: '36', condition: 'CARIES' }],
    });
    mockOpenAi(service, { text: SAMPLE_TRANSCRIPT }, classificationJson);

    const result = await service.dictate(CLINIC_ID, USER_ID, buildDto());

    // 'CARIES' lowercased → 'caries' which is valid
    expect(result.odontogramSuggestions).toHaveLength(1);
    expect(result.odontogramSuggestions[0].condition).toBe('caries');
  });

  it('capitalizes the first letter of notes from odontogram suggestions', async () => {
    const classificationJson = JSON.stringify({
      fields: {},
      odontogramSuggestions: [
        {
          toothNumber: '36',
          condition: 'caries',
          notes: 'cárie profunda observada',
        },
      ],
    });
    mockOpenAi(service, { text: SAMPLE_TRANSCRIPT }, classificationJson);

    const result = await service.dictate(CLINIC_ID, USER_ID, buildDto());

    expect(result.odontogramSuggestions[0].notes).toBe(
      'Cárie profunda observada',
    );
  });

  it('truncates notes and sourceText to their respective length limits', async () => {
    const longNotes = 'N'.repeat(600); // exceeds MAX_NOTES_LENGTH (500)
    const longSource = 'S'.repeat(250); // exceeds MAX_SOURCE_TEXT_LENGTH (200)
    const classificationJson = JSON.stringify({
      fields: {},
      odontogramSuggestions: [
        {
          toothNumber: '36',
          condition: 'caries',
          notes: longNotes,
          sourceText: longSource,
        },
      ],
    });
    mockOpenAi(service, { text: SAMPLE_TRANSCRIPT }, classificationJson);

    const result = await service.dictate(CLINIC_ID, USER_ID, buildDto());

    expect(
      (result.odontogramSuggestions[0].notes ?? '').length,
    ).toBeLessThanOrEqual(500);
    expect(
      (result.odontogramSuggestions[0].sourceText ?? '').length,
    ).toBeLessThanOrEqual(200);
  });

  // ── Field capitalization ──────────────────────────────────────────────────

  it('capitalizes the first letter of each clinical field value', async () => {
    const classificationJson = JSON.stringify({
      fields: {
        chiefComplaint: 'dor no dente 36', // lowercase start
        clinicalEvolution: 'sensibilidade ao frio', // lowercase start
      },
    });
    mockOpenAi(service, { text: SAMPLE_TRANSCRIPT }, classificationJson);

    const result = await service.dictate(CLINIC_ID, USER_ID, buildDto());

    expect(result.fields.chiefComplaint).toBe('Dor no dente 36');
    expect(result.fields.clinicalEvolution).toBe('Sensibilidade ao frio');
  });

  it('does not alter field values that already start with uppercase', async () => {
    const classificationJson = JSON.stringify({
      fields: { diagnosis: 'ATM com dor à palpação.' },
    });
    mockOpenAi(service, { text: SAMPLE_TRANSCRIPT }, classificationJson);

    const result = await service.dictate(CLINIC_ID, USER_ID, buildDto());

    // 'ATM' must remain uppercase; capitalizeFirst only touches the first char
    expect(result.fields.diagnosis).toBe('ATM com dor à palpação.');
  });

  // ── Safe metadata in saveSuccess ──────────────────────────────────────────

  it('includes odontogramSuggestionsCount in saveSuccess metadata', async () => {
    const classificationJson = JSON.stringify({
      fields: {},
      odontogramSuggestions: [
        { toothNumber: '36', condition: 'caries' },
        { toothNumber: '11', condition: 'crown' },
      ],
    });
    mockOpenAi(service, { text: SAMPLE_TRANSCRIPT }, classificationJson);

    await service.dictate(CLINIC_ID, USER_ID, buildDto());
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const savedContent = mockRepository.saveSuccess.mock.calls[0][0]
      .content as Record<string, unknown>;
    expect(savedContent.odontogramSuggestionsCount).toBe(2);
    // Patient data must still not be present
    expect(Object.keys(savedContent)).not.toContain('transcript');
    expect(Object.keys(savedContent)).not.toContain('odontogramSuggestions');
  });
});

// ── 22. VALID_FDI_TOOTH_NUMBERS and VALID_ODONTOGRAM_CONDITIONS constants ─────

describe('validation constant exports', () => {
  it('VALID_FDI_TOOTH_NUMBERS contains expected permanent teeth', () => {
    expect(VALID_FDI_TOOTH_NUMBERS.has('11')).toBe(true);
    expect(VALID_FDI_TOOTH_NUMBERS.has('36')).toBe(true);
    expect(VALID_FDI_TOOTH_NUMBERS.has('48')).toBe(true);
  });

  it('VALID_FDI_TOOTH_NUMBERS contains expected deciduous teeth', () => {
    expect(VALID_FDI_TOOTH_NUMBERS.has('51')).toBe(true);
    expect(VALID_FDI_TOOTH_NUMBERS.has('75')).toBe(true);
    expect(VALID_FDI_TOOTH_NUMBERS.has('85')).toBe(true);
  });

  it('VALID_FDI_TOOTH_NUMBERS rejects numbers outside the FDI set', () => {
    expect(VALID_FDI_TOOTH_NUMBERS.has('99')).toBe(false);
    expect(VALID_FDI_TOOTH_NUMBERS.has('10')).toBe(false);
    expect(VALID_FDI_TOOTH_NUMBERS.has('50')).toBe(false);
  });

  it('VALID_ODONTOGRAM_CONDITIONS contains all 13 expected condition values', () => {
    const expected = [
      'healthy',
      'caries',
      'restored',
      'absent',
      'extraction',
      'fracture',
      'mobility',
      'crown',
      'endodontic',
      'implant',
      'prosthetic',
      'sealant',
      'watch',
    ];
    for (const c of expected) {
      expect(VALID_ODONTOGRAM_CONDITIONS.has(c)).toBe(true);
    }
  });
});
