import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { AddClinicalAttachmentDto } from './clinical-attachment.dto';
import { ClinicalIdentifierQueryDto } from './clinical-record-query.dto';
import { CreateClinicalRecordDto } from './create-clinical-record.dto';
import { CreateClinicalTemplateDto } from './create-clinical-template.dto';
import { UpsertOdontogramDto } from './odontogram.dto';

async function validateDto<T extends object>(
  cls: new () => T,
  payload: Record<string, unknown>,
) {
  return validate(plainToInstance(cls, payload));
}

function nestedObject(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { value: true };

  for (let index = 0; index < depth; index += 1) {
    value = { child: value };
  }

  return value;
}

describe('clinical records DTO validation', () => {
  it('rejects missing identifier query', async () => {
    const errors = await validateDto(ClinicalIdentifierQueryDto, {});

    expect(errors).toHaveLength(1);
  });

  it('rejects empty identifier query after trimming', async () => {
    const errors = await validateDto(ClinicalIdentifierQueryDto, {
      identifier: '   ',
    });

    expect(errors).toHaveLength(1);
  });

  it('rejects overlong patient identifier', async () => {
    const errors = await validateDto(ClinicalIdentifierQueryDto, {
      identifier: 'a'.repeat(255),
    });

    expect(errors).toHaveLength(1);
  });

  it('rejects overlong clinical text fields', async () => {
    const errors = await validateDto(CreateClinicalRecordDto, {
      profileId: 'profile-1',
      patientName: 'Paciente Teste',
      anamnesis: 'a'.repeat(10_001),
    });

    expect(errors.some((error) => error.property === 'anamnesis')).toBe(true);
  });

  it('rejects overlong template content', async () => {
    const errors = await validateDto(CreateClinicalTemplateDto, {
      name: 'Modelo',
      category: 'OTHER',
      content: 'a'.repeat(10_001),
    });

    expect(errors.some((error) => error.property === 'content')).toBe(true);
  });

  it('rejects invalid attachment MIME type', async () => {
    const errors = await validateDto(AddClinicalAttachmentDto, {
      fileName: 'foto.png',
      mimeType: 'application/pdf',
    });

    expect(errors.some((error) => error.property === 'mimeType')).toBe(true);
  });

  it('rejects path-like attachment file names', async () => {
    const errors = await validateDto(AddClinicalAttachmentDto, {
      fileName: '../foto.png',
      mimeType: 'image/png',
    });

    expect(errors.some((error) => error.property === 'fileName')).toBe(true);
  });

  it('rejects excessive attachment description and base64 fields', async () => {
    const errors = await validateDto(AddClinicalAttachmentDto, {
      fileName: 'foto.png',
      mimeType: 'image/png',
      description: 'a'.repeat(501),
      dataBase64: 'a'.repeat(120_001),
    });

    expect(errors.some((error) => error.property === 'description')).toBe(true);
    expect(errors.some((error) => error.property === 'dataBase64')).toBe(true);
  });

  it('rejects invalid attachment sizeBytes', async () => {
    const errors = await validateDto(AddClinicalAttachmentDto, {
      fileName: 'foto.png',
      mimeType: 'image/png',
      sizeBytes: 2 * 1024 * 1024 + 1,
    });

    expect(errors.some((error) => error.property === 'sizeBytes')).toBe(true);
  });

  it('rejects primitive odontogram data', async () => {
    const errors = await validateDto(UpsertOdontogramDto, {
      identifier: 'paciente@example.com',
      patientName: 'Paciente Teste',
      data: 'not-an-object',
    });

    expect(errors.some((error) => error.property === 'data')).toBe(true);
  });

  it('rejects array odontogram data', async () => {
    const errors = await validateDto(UpsertOdontogramDto, {
      identifier: 'paciente@example.com',
      patientName: 'Paciente Teste',
      data: [],
    });

    expect(errors.some((error) => error.property === 'data')).toBe(true);
  });

  it('rejects overly deep odontogram JSON', async () => {
    const errors = await validateDto(UpsertOdontogramDto, {
      identifier: 'paciente@example.com',
      patientName: 'Paciente Teste',
      data: nestedObject(9),
    });

    expect(errors.some((error) => error.property === 'data')).toBe(true);
  });
});
