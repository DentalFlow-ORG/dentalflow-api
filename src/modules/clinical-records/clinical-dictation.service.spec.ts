import {
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type OpenAI from 'openai';

import {
  CLINICAL_FIELD_KEYS,
  ClinicalDictationService,
} from './clinical-dictation.service';
import type { DictationResult } from './clinical-dictation.service';

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
  return new ClinicalDictationService();
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

    const result: DictationResult = await service.dictate(buildDto());

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

    await expect(svcWithoutKey.dictate(buildDto())).rejects.toThrow(
      ServiceUnavailableException,
    );

    // openai property is null — no SDK call can have been made
    const openaiProp = (svcWithoutKey as unknown as { openai: OpenAI | null }).openai;
    expect(openaiProp).toBeNull();
  });

  // ── 3. Whisper generic failure ────────────────────────────────────────────

  it('throws InternalServerErrorException on a generic Whisper error', async () => {
    mockTranscriptionOnly(service, new Error('Network error'));

    await expect(service.dictate(buildDto())).rejects.toThrow(
      InternalServerErrorException,
    );
    // Classification is never reached
    expect(getClassificationMock(service)).not.toHaveBeenCalled();
  });

  // ── 4. Whisper rate limit ─────────────────────────────────────────────────

  it('throws ServiceUnavailableException on a Whisper 429 rate-limit error', async () => {
    const rateLimitErr = Object.assign(new Error('Rate limited'), { status: 429 });
    mockTranscriptionOnly(service, rateLimitErr);

    await expect(service.dictate(buildDto())).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  // ── 5. GPT generic failure ────────────────────────────────────────────────

  it('throws InternalServerErrorException on a generic GPT classification error', async () => {
    mockClassificationError(service, new Error('GPT internal error'));

    await expect(service.dictate(buildDto())).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(getTranscriptionMock(service)).toHaveBeenCalledTimes(1);
  });

  // ── 6. GPT rate limit ─────────────────────────────────────────────────────

  it('throws ServiceUnavailableException on a GPT 429 rate-limit error', async () => {
    const rateLimitErr = Object.assign(new Error('Rate limited'), { status: 429 });
    mockClassificationError(service, rateLimitErr);

    await expect(service.dictate(buildDto())).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(getTranscriptionMock(service)).toHaveBeenCalledTimes(1);
  });

  // ── 7. Malformed GPT JSON ─────────────────────────────────────────────────

  it('throws InternalServerErrorException when GPT returns malformed JSON', async () => {
    mockOpenAi(service, { text: SAMPLE_TRANSCRIPT }, 'NOT VALID JSON {{{');

    await expect(service.dictate(buildDto())).rejects.toThrow(
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

    const result = await service.dictate(buildDto());

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

    const result = await service.dictate(buildDto());

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

    const result = await service.dictate(buildDto());

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

    const result = await service.dictate(buildDto());

    expect(result.fields.chiefComplaint).toHaveLength(2000);
    expect(result.fields.diagnosis).toHaveLength(2000);
  });
});
