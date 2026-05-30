import {
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import OpenAI, { toFile } from 'openai';

import type { DictateRecordDto } from './dto/dictate-record.dto';

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
// Conservative: only fills fields when the transcript clearly states content.
// Never invents information; uncertain content is omitted or placed in privateNotes.

const CLASSIFICATION_SYSTEM_PROMPT = `\
Você é um assistente de documentação clínica odontológica.
Receberá a transcrição de uma consulta em português e deve organizar o conteúdo \
nos campos corretos do prontuário.

REGRAS ABSOLUTAS:
- Use SOMENTE o que estiver explicitamente na transcrição. Nunca invente, extrapole ou presuma.
- Se o conteúdo não couber claramente em nenhum campo, NÃO inclua.
- Diagnósticos: inclua apenas se afirmados explicitamente pelo profissional.
- Informações ambíguas: omita do resultado ou coloque em privateNotes somente se o \
profissional as tratou como observação interna.
- Preserve o idioma original (português).
- Retorne APENAS JSON válido no formato indicado abaixo. Nenhum texto fora do JSON.
- Todos os campos são opcionais. Omita campos sem conteúdo claro na transcrição.

CAMPOS DISPONÍVEIS:
- chiefComplaint: queixa principal relatada pelo paciente, motivo da consulta.
- anamnesis: histórico médico e odontológico, alergias, medicamentos em uso, \
condições sistêmicas, hábitos relevantes.
- clinicalEvolution: achados clínicos, evolução do caso, observações durante o atendimento.
- diagnosis: diagnóstico clínico ou hipótese diagnóstica, dentes e regiões envolvidos, \
achados de exame clínico ou radiografia.
- proceduresPerformed: procedimentos executados na consulta atual, materiais utilizados, \
técnica anestésica, dentes tratados.
- treatmentPlan: sequência de tratamento proposta, próximas etapas, prioridades, \
encaminhamentos necessários.
- prescription: medicamentos prescritos com nome, dosagem, frequência e duração.
- recommendations: orientações pós-consulta, higiene oral, restrições alimentares, \
sinais de alerta, data de retorno.
- privateNotes: observações internas do profissional, somente quando explicitamente \
indicadas como tal.

FORMATO DE RESPOSTA OBRIGATÓRIO:
{
  "fields": {
    "chiefComplaint": "texto",
    "anamnesis": "texto"
  }
}
Inclua apenas os campos com conteúdo claro. Omita os demais.`;

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class ClinicalDictationService {
  private readonly logger = new Logger(ClinicalDictationService.name);
  // Nullable — may be unconfigured when OPENAI_API_KEY is absent.
  private readonly openai: OpenAI | null = null;
  private readonly classificationModel: string;

  constructor() {
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

  async dictate(dto: DictateRecordDto): Promise<DictationResult> {
    this.assertEnabled();
    const startedAt = Date.now();

    const transcript = await this.transcribeAudio(dto);
    const fields = await this.classifyTranscript(transcript);

    this.logSuccess(transcript.length, Object.keys(fields), Date.now() - startedAt);
    return { transcript, fields };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private assertEnabled(): void {
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
    const audioBuffer = Buffer.from(dto.audioBase64, 'base64');
    const audioFile = await toFile(audioBuffer, 'recording', { type: dto.mimeType });

    try {
      const response = await this.openai!.audio.transcriptions.create({
        file: audioFile,
        model: TRANSCRIPTION_MODEL,
        language: 'pt',
      });
      return response.text;
    } catch (err: unknown) {
      return this.handleOpenAiError(err, 'transcription');
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

    // parseFields throws InternalServerErrorException on bad JSON — let it propagate.
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
      throw new InternalServerErrorException(
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

  /** Classifies an OpenAI error and re-throws a controlled Nest exception. Never returns. */
  private handleOpenAiError(err: unknown, phase: string): never {
    const isRateLimit =
      typeof err === 'object' &&
      err !== null &&
      'status' in err &&
      (err as { status: number }).status === 429;

    this.logger.error(
      JSON.stringify({
        event: 'clinical_dictation_error',
        phase,
        errorCode: isRateLimit ? 'RATE_LIMIT' : 'OPENAI_ERROR',
        createdAt: new Date().toISOString(),
      }),
    );

    if (isRateLimit) {
      throw new ServiceUnavailableException(
        'O assistente está temporariamente sobrecarregado. Tente novamente em alguns instantes.',
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
