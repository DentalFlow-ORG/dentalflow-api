import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  ALLOWED_AUDIO_MIME_TYPES,
  DictateRecordDto,
  MAX_AUDIO_BASE64_LENGTH,
  MAX_DURATION_SECONDS,
} from './dictate-record.dto';
import { PlanFeature, getPlanFeatures } from '../../billing/plan-feature.types';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function validateDto<T extends object>(
  cls: new () => T,
  payload: Record<string, unknown>,
) {
  return validate(plainToInstance(cls, payload));
}

const VALID_PAYLOAD = {
  audioBase64: 'UklGRiQAAABXQVZFZm10IBAAAAABAAEA',
  mimeType: 'audio/webm',
  durationSeconds: 30,
};

// ── DictateRecordDto ──────────────────────────────────────────────────────────

describe('DictateRecordDto', () => {
  it('accepts a valid payload', async () => {
    const errors = await validateDto(DictateRecordDto, VALID_PAYLOAD);
    expect(errors).toHaveLength(0);
  });

  it('trims audioBase64 when it has surrounding whitespace', async () => {
    const errors = await validateDto(DictateRecordDto, {
      ...VALID_PAYLOAD,
      audioBase64: '  UklGRiQAAABXQVZFZm10IBAAAAABAAEA  ',
    });
    expect(errors).toHaveLength(0);
  });

  it('accepts all allowed MIME types', async () => {
    for (const mimeType of ALLOWED_AUDIO_MIME_TYPES) {
      const errors = await validateDto(DictateRecordDto, {
        ...VALID_PAYLOAD,
        mimeType,
      });
      expect(errors).toHaveLength(0);
    }
  });

  it('rejects an unsupported MIME type', async () => {
    const errors = await validateDto(DictateRecordDto, {
      ...VALID_PAYLOAD,
      mimeType: 'video/mp4',
    });
    expect(errors.some((e) => e.property === 'mimeType')).toBe(true);
  });

  it('rejects a missing audioBase64', async () => {
    const errors = await validateDto(DictateRecordDto, {
      mimeType: 'audio/webm',
    });
    expect(errors.some((e) => e.property === 'audioBase64')).toBe(true);
  });

  it('rejects a missing mimeType', async () => {
    const errors = await validateDto(DictateRecordDto, {
      audioBase64: VALID_PAYLOAD.audioBase64,
    });
    expect(errors.some((e) => e.property === 'mimeType')).toBe(true);
  });

  it('rejects non-base64 characters in audioBase64', async () => {
    const errors = await validateDto(DictateRecordDto, {
      ...VALID_PAYLOAD,
      audioBase64: 'not-valid-@@@',
    });
    expect(errors.some((e) => e.property === 'audioBase64')).toBe(true);
  });

  it(`rejects audioBase64 longer than MAX_AUDIO_BASE64_LENGTH (${MAX_AUDIO_BASE64_LENGTH})`, async () => {
    const errors = await validateDto(DictateRecordDto, {
      ...VALID_PAYLOAD,
      audioBase64: 'A'.repeat(MAX_AUDIO_BASE64_LENGTH + 1),
    });
    expect(errors.some((e) => e.property === 'audioBase64')).toBe(true);
  });

  it('rejects durationSeconds below 1', async () => {
    const errors = await validateDto(DictateRecordDto, {
      ...VALID_PAYLOAD,
      durationSeconds: 0,
    });
    expect(errors.some((e) => e.property === 'durationSeconds')).toBe(true);
  });

  it(`rejects durationSeconds above MAX_DURATION_SECONDS (${MAX_DURATION_SECONDS})`, async () => {
    const errors = await validateDto(DictateRecordDto, {
      ...VALID_PAYLOAD,
      durationSeconds: MAX_DURATION_SECONDS + 1,
    });
    expect(errors.some((e) => e.property === 'durationSeconds')).toBe(true);
  });

  it('rejects a non-integer durationSeconds', async () => {
    const errors = await validateDto(DictateRecordDto, {
      ...VALID_PAYLOAD,
      durationSeconds: 30.5,
    });
    expect(errors.some((e) => e.property === 'durationSeconds')).toBe(true);
  });

  it('allows durationSeconds to be omitted', async () => {
    const { durationSeconds: _omit, ...withoutDuration } = VALID_PAYLOAD;
    const errors = await validateDto(DictateRecordDto, withoutDuration);
    expect(errors).toHaveLength(0);
  });
});

// ── PlanFeature.CLINICAL_DICTATION ────────────────────────────────────────────

describe('PlanFeature.CLINICAL_DICTATION', () => {
  it('exists in the PlanFeature enum', () => {
    expect(PlanFeature.CLINICAL_DICTATION).toBe('CLINICAL_DICTATION');
  });

  it('is available for premium only — not starter or professional', () => {
    expect(getPlanFeatures('premium').has(PlanFeature.CLINICAL_DICTATION)).toBe(
      true,
    );
    expect(
      getPlanFeatures('professional').has(PlanFeature.CLINICAL_DICTATION),
    ).toBe(false);
    expect(getPlanFeatures('starter').has(PlanFeature.CLINICAL_DICTATION)).toBe(
      false,
    );
    expect(getPlanFeatures(null).has(PlanFeature.CLINICAL_DICTATION)).toBe(
      false,
    );
    expect(
      getPlanFeatures('unknown-plan').has(PlanFeature.CLINICAL_DICTATION),
    ).toBe(false);
  });
});
