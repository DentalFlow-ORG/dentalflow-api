import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AiAssistantAnalysisType } from '@prisma/client';
import OpenAI, { toFile } from 'openai';

import { AiAssistantAnalysisRepository } from '../ai-assistant/ai-assistant-analysis.repository';
import { AiQuotaService } from '../ai-assistant/ai-quota.service';
import type { DictateRecordDto } from './dto/dictate-record.dto';

// ── Audio MIME normalizer ─────────────────────────────────────────────────────
// OpenAI Whisper requires the filename extension to determine the audio format.
// Browsers commonly report MIME types with codec parameters, e.g.
// 'audio/webm;codecs=opus', which are NOT accepted by OpenAI as a Content-Type
// and produce a 400 when embedded in a filename.
//
// This helper strips codec parameters, maps the base MIME to a clean extension,
// and returns a safe filename for the multipart upload.
//
// Whisper-supported extensions: flac m4a mp3 mp4 mpeg mpga oga ogg wav webm
// Only the subset allowed by the DTO is mapped here.

export type AudioNormalization = {
  /** Base MIME type with no codec parameters, e.g. 'audio/webm'. */
  mimeType: string;
  /** Safe filename for the OpenAI upload, e.g. 'dictation.webm'. */
  filename: string;
};

export function normalizeAudioMime(rawMime: string): AudioNormalization {
  // Strip everything from the first ';' onward: 'audio/webm;codecs=opus' → 'audio/webm'
  const base = rawMime.split(';')[0].trim().toLowerCase();

  const EXT_MAP: Record<string, string> = {
    'audio/webm': 'webm',
    'audio/ogg':  'ogg',
    'audio/mp4':  'mp4',
    'audio/mpeg': 'mp3',
    'audio/wav':  'wav',
  };

  const ext = EXT_MAP[base];
  if (!ext) {
    throw new BadRequestException(
      'Formato de áudio não reconhecido. Grave novamente e tente outra vez.',
    );
  }

  return { mimeType: base, filename: `dictation.${ext}` };
}

// ── Field catalogue ───────────────────────────────────────────────────────────
// Matches exactly the nullable text columns on ClinicalRecord.
// All classification output is validated against this whitelist.

export const CLINICAL_FIELD_KEYS = [
  'chiefComplaint',
  'anamnesis',
  'clinicalEvolution',
  'diagnosis',
  'proceduresPerformed',
  'treatmentPlan',
  'prescription',
  'recommendations',
  'privateNotes',
] as const;

export type ClinicalFieldKey = (typeof CLINICAL_FIELD_KEYS)[number];

// ── Result type ───────────────────────────────────────────────────────────────

export interface DictationResult {
  /** Raw transcript returned by Whisper. Never stored; shown to dentist for review. */
  transcript: string;
  /** Whitelisted clinical fields extracted by GPT. Subset of CLINICAL_FIELD_KEYS. */
  fields: Partial<Record<ClinicalFieldKey, string>>;
}

// ── Internal constants ────────────────────────────────────────────────────────

const TRANSCRIPTION_MODEL = 'whisper-1';
const CLASSIFICATION_TEMPERATURE = 0.1;
const CLASSIFICATION_MAX_TOKENS = 1200;
const MAX_FIELD_LENGTH = 2000;

// ── Classification prompt ─────────────────────────────────────────────────────
// Conservative: only fills fields when the transcript clearly supports it.
// Never invents information; uncertain or absent content is omitted.
// Exported so spec tests can verify key behavioral properties without snapshotting
// the full text.

export const CLASSIFICATION_SYSTEM_PROMPT = `\
Você é um assistente de documentação clínica odontológica.
Receberá a transcrição de uma consulta odontológica em português e deve \
classificar o conteúdo nos campos corretos do prontuário digital.

REGRAS ABSOLUTAS — VIOLÁ-LAS INVALIDA A RESPOSTA:
1. Use EXCLUSIVAMENTE o que estiver declarado na transcrição.
   Nunca invente, extrapole, deduza nem complete informações não mencionadas.
2. Diagnósticos: registre apenas afirmações explícitas do profissional de saúde.
3. Conteúdo ambíguo ou incerto: omita ou registre em privateNotes somente quando \
o profissional o tratar explicitamente como observação interna.
4. Preserve a terminologia clínica, a numeração FDI dos dentes \
(ex: dente 36, dentes 11 e 21) e nomes de medicamentos como pronunciados.
5. Escreva em português clínico profissional. Evite repetições entre campos.
6. Retorne SOMENTE JSON válido no formato indicado. Nenhum texto fora do JSON.
7. Omita qualquer campo sem conteúdo explícito e claro na transcrição.

CAMPOS DISPONÍVEIS E CRITÉRIOS DE PREENCHIMENTO:
- chiefComplaint: queixa principal relatada pelo paciente ou motivo da consulta. \
  Ex: "Dor espontânea no dente 36 há dois dias."
- anamnesis: histórico médico e odontológico, alergias, medicamentos em uso \
  (nome, dose, frequência), condições sistêmicas, hábitos relevantes.
- clinicalEvolution: observações clínicas do atendimento — exame intraoral, \
  condição periodontal, resposta pulpar, achados radiográficos. \
  Não inclua o diagnóstico neste campo.
- diagnosis: diagnóstico confirmado ou hipótese diagnóstica, com dentes e \
  achados que o sustentam. Ex: "Cárie profunda no dente 36."
- proceduresPerformed: procedimentos realizados nesta consulta — anestesia, \
  materiais, instrumentos, numeração dos dentes tratados e etapas executadas.
- treatmentPlan: sequência de tratamento proposta, próximas sessões, \
  prioridades e encaminhamentos para especialistas.
- prescription: medicamentos prescritos com nome, dosagem, frequência e duração. \
  Ex: "Amoxicilina 500mg, 1 cápsula a cada 8h por 7 dias."
- recommendations: orientações pós-consulta, higiene oral, restrições \
  alimentares, sinais de alerta e prazo de retorno.
- privateNotes: observações internas do profissional, somente quando \
  mencionadas explicitamente como tal.

FORMATO DE RESPOSTA OBRIGATÓRIO:
{"fields": {"campo": "texto clínico"}}
Inclua apenas os campos com conteúdo claro e explícito na transcrição.`;

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class ClinicalDictationService {
  private readonly logger = new Logger(ClinicalDictationService.name);
  // Nullable — may be unconfigured when OPENAI_API_KEY is absent.
  private readonly openai: OpenAI | null = null;
  private readonly classificationModel: string;

  constructor(
    private readonly quotaService: AiQuotaService,
    private readonly analysisRepository: AiAssistantAnalysisRepository,
  ) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      this.logger.warn(
        'OPENAI_API_KEY not configured — clinical dictation disabled.',
      );
    } else {
      this.openai = new OpenAI({ apiKey });
    }
    this.classificationModel = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async dictate(clinicId: string, userId: string, dto: DictateRecordDto): Promise<DictationResult> {
    // Order: kill-switch → quota → OpenAI → record usage
    this.assertEnabled();
    await this.quotaService.assertQuota(clinicId, AiAssistantAnalysisType.CLINICAL_DICTATION);

    const startedAt = Date.now();
    const transcript = await this.transcribeAudio(dto);
    const fields = await this.classifyTranscript(transcript);

    this.logSuccess(transcript.length, Object.keys(fields), Date.now() - startedAt);

    // Record successful usage for monthly quota tracking.
    // Best-effort: a DB write failure must never break the dictation response.
    // Content contains only safe metadata — no transcript text or field values.
    this.analysisRepository.saveSuccess({
      clinicId,
      userId,
      type: AiAssistantAnalysisType.CLINICAL_DICTATION,
      content: {
        transcriptLength: transcript.length,
        fieldsClassified: Object.keys(fields),
      },
      model: this.classificationModel,
      generatedAt: new Date(),
      periodStart: null,
      periodEnd: null,
    }).catch((err: unknown) => {
      this.logger.error(
        JSON.stringify({
          event: 'clinical_dictation_quota_record_failed',
          errorCode: 'PERSISTENCE_ERROR',
          createdAt: new Date().toISOString(),
        }),
      );
    });

    return { transcript, fields };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private assertEnabled(): void {
    // Respect the global AI kill-switch used by all other AI services.
    // Setting OPENAI_AI_ASSISTANT_ENABLED=false disables dictation without
    // requiring the API key to be removed from the environment.
    if (process.env.OPENAI_AI_ASSISTANT_ENABLED === 'false') {
      throw new ServiceUnavailableException(
        'O assistente de ditado clínico está desabilitado no momento.',
      );
    }
    if (!this.openai) {
      throw new ServiceUnavailableException(
        'O assistente de ditado clínico está indisponível. Contate o suporte.',
      );
    }
  }

  /**
   * Converts base64 audio to a File and sends it to Whisper for Portuguese transcription.
   * The audio buffer is never logged or persisted.
   */
  private async transcribeAudio(dto: DictateRecordDto): Promise<string> {
    // ── 1. Normalize MIME → clean type + safe filename ─────────────────────
    // Strips codec params so 'audio/webm;codecs=opus' → { mimeType: 'audio/webm',
    // filename: 'dictation.webm' }.  Without a proper extension Whisper returns 400.
    const { mimeType: normalizedMime, filename } = normalizeAudioMime(dto.mimeType);

    // ── 2. Normalize base64 ────────────────────────────────────────────────
    // The frontend already strips the data-URL prefix, but be defensive:
    // trim whitespace, collapse embedded newlines, and strip any accidental prefix.
    const cleanBase64 = (
      dto.audioBase64.includes(',')
        ? (dto.audioBase64.split(',')[1] ?? dto.audioBase64)
        : dto.audioBase64
    ).replace(/\s+/g, '');

    // ── 3. Build audio File ────────────────────────────────────────────────
    let audioFile: Awaited<ReturnType<typeof toFile>>;
    let audioBytes = 0;
    try {
      const audioBuffer = Buffer.from(cleanBase64, 'base64');
      audioBytes = audioBuffer.length;
      audioFile = await toFile(audioBuffer, filename, { type: normalizedMime });
    } catch {
      throw new BadRequestException(
        'O áudio não pôde ser processado. Verifique a qualidade da gravação e tente novamente.',
      );
    }

    // ── 4. Transcribe ──────────────────────────────────────────────────────
    try {
      const response = await this.openai!.audio.transcriptions.create({
        file: audioFile,
        model: TRANSCRIPTION_MODEL,
        language: 'pt',
      });
      return response.text;
    } catch (err: unknown) {
      return this.handleOpenAiError(err, 'transcription', {
        rawMime: dto.mimeType,
        normalizedMime,
        filename,
        audioBytes,
      });
    }
  }

  /**
   * Sends the transcript to GPT in JSON mode and extracts whitelisted clinical fields.
   * The raw transcript is used only as GPT input and is never logged.
   */
  private async classifyTranscript(
    transcript: string,
  ): Promise<Partial<Record<ClinicalFieldKey, string>>> {
    let raw: string;

    try {
      const response = await this.openai!.chat.completions.create({
        model: this.classificationModel,
        response_format: { type: 'json_object' },
        temperature: CLASSIFICATION_TEMPERATURE,
        max_tokens: CLASSIFICATION_MAX_TOKENS,
        messages: [
          { role: 'system', content: CLASSIFICATION_SYSTEM_PROMPT },
          { role: 'user', content: transcript },
        ],
      });
      raw = response.choices[0]?.message?.content ?? '{}';
    } catch (err: unknown) {
      return this.handleOpenAiError(err, 'classification');
    }

    // parseFields throws ServiceUnavailableException on bad JSON — let it propagate.
    return this.parseFields(raw);
  }

  /**
   * Safely parses the GPT response JSON and returns only whitelisted, non-empty string fields.
   * Tolerates both `{ fields: { ... } }` and flat `{ fieldName: value }` shapes.
   * Unknown keys, non-string values, and empty strings are silently dropped.
   */
  private parseFields(raw: string): Partial<Record<ClinicalFieldKey, string>> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.error(
        JSON.stringify({
          event: 'clinical_dictation_parse_error',
          errorCode: 'INVALID_JSON_RESPONSE',
          createdAt: new Date().toISOString(),
        }),
      );
      // GPT producing invalid JSON is a transient model reliability issue, not
      // a permanent internal code bug — 503 encourages the user to try again.
      throw new ServiceUnavailableException(
        'A resposta da IA veio em formato inválido. Tente novamente.',
      );
    }

    const topLevel =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};

    // Accept both { "fields": { ... } } and flat { "fieldName": value } shapes.
    const fieldSource: Record<string, unknown> =
      topLevel.fields !== null &&
      typeof topLevel.fields === 'object' &&
      !Array.isArray(topLevel.fields)
        ? (topLevel.fields as Record<string, unknown>)
        : topLevel;

    const result: Partial<Record<ClinicalFieldKey, string>> = {};
    for (const key of CLINICAL_FIELD_KEYS) {
      const value = fieldSource[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        result[key] = value.trim().slice(0, MAX_FIELD_LENGTH);
      }
    }
    return result;
  }

  /**
   * Classifies an OpenAI error and re-throws a controlled Nest exception. Never returns.
   *
   * @param meta  Optional safe metadata (e.g. normalizedMime, filename, audioBytes) to
   *              include in the error log.  Must NOT contain audio content or tokens.
   */
  private handleOpenAiError(
    err: unknown,
    phase: 'transcription' | 'classification',
    meta?: Record<string, unknown>,
  ): never {
    const status =
      typeof err === 'object' && err !== null && 'status' in err
        ? (err as { status: number }).status
        : undefined;

    const isRateLimit = status === 429;
    // A 400 from Whisper means the audio itself was unacceptable (too short,
    // silent, wrong format, etc.).  For the classification phase a 400 would
    // indicate a malformed API request — treat that as an internal error instead.
    const isInvalidAudio = phase === 'transcription' && status === 400;
    // 401 = bad/missing API key, 404 = model not found, 500/503 = OpenAI outage.
    // All of these mean the service is (temporarily) unavailable — don't leak
    // key/model details to the client.
    const isOpenAiUnavailable =
      status === 401 || status === 404 || status === 500 || status === 503;

    this.logger.error(
      JSON.stringify({
        event: 'clinical_dictation_error',
        phase,
        errorCode: isRateLimit
          ? 'RATE_LIMIT'
          : isInvalidAudio
            ? 'INVALID_AUDIO'
            : isOpenAiUnavailable
              ? 'OPENAI_UNAVAILABLE'
              : 'OPENAI_ERROR',
        httpStatus: status ?? null,
        ...(meta ?? {}),
        createdAt: new Date().toISOString(),
      }),
    );

    if (isRateLimit) {
      throw new ServiceUnavailableException(
        'O assistente está temporariamente sobrecarregado. Tente novamente em alguns instantes.',
      );
    }

    if (isOpenAiUnavailable) {
      throw new ServiceUnavailableException(
        'O assistente está temporariamente indisponível. Tente novamente em alguns instantes.',
      );
    }

    if (isInvalidAudio) {
      throw new BadRequestException(
        'O áudio não pôde ser processado. Verifique a qualidade da gravação e tente novamente.',
      );
    }

    throw new InternalServerErrorException(
      'Não foi possível processar o ditado clínico. Tente novamente.',
    );
  }

  /** Logs only safe metadata — never patient content, transcript text, or audio. */
  private logSuccess(
    transcriptLength: number,
    fieldNames: string[],
    durationMs: number,
  ): void {
    this.logger.log(
      JSON.stringify({
        event: 'clinical_dictation_success',
        transcriptLength,
        fieldsClassified: fieldNames,
        model: this.classificationModel,
        durationMs,
        createdAt: new Date().toISOString(),
      }),
    );
  }
}
