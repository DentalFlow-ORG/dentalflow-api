import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { MAX_CENTS_AMOUNT } from '../../../common/validators/input-validation.decorators';
import {
  CancelInvoiceDto,
  CreateServiceInvoiceDto,
  UpdateServiceInvoiceDto,
} from './invoice.dto';
import { UpsertFiscalProfileDto } from './upsert-fiscal-profile.dto';

async function check<T extends object>(
  cls: new () => T,
  payload: Record<string, unknown>,
) {
  const instance = plainToInstance(cls, payload);
  const errors = await validate(instance);
  return { instance, props: errors.map((error) => error.property) };
}

const validInvoice = {
  customerName: 'Ana Martins',
  serviceDescription: 'Consulta odontológica',
  amountCents: 25000,
  competenceDate: '2026-09-01',
};

const validProfile = {
  legalName: 'Clínica Sorriso LTDA',
  documentType: 'CNPJ',
  documentNumber: '11.222.333/0001-81',
  taxRegime: 'SIMPLES_NACIONAL',
  addressStreet: 'Rua das Flores',
  addressNumber: '100',
  addressNeighborhood: 'Centro',
  addressCity: 'Brasília',
  addressState: 'df',
  addressZipCode: '70000-000',
};

describe('invoice DTO validation', () => {
  describe('CreateServiceInvoiceDto', () => {
    it('accepts a minimal valid invoice', async () => {
      const { props } = await check(CreateServiceInvoiceDto, validInvoice);
      expect(props).toEqual([]);
    });

    // Regression: the web form sends '' for an empty optional e-mail, and
    // `@IsOptional()` alone let '' reach `@IsEmail()` — every invoice without
    // an e-mail was rejected with 400.
    it.each(['customerEmail', 'customerDocument', 'customerPhone', 'notes'])(
      'treats a blank %s as not provided',
      async (field) => {
        const { props, instance } = await check(CreateServiceInvoiceDto, {
          ...validInvoice,
          [field]: '  ',
        });
        expect(props).toEqual([]);
        expect(
          (instance as unknown as Record<string, unknown>)[field],
        ).toBeUndefined();
      },
    );

    it('rejects a malformed e-mail and lowercases a valid one', async () => {
      expect(
        (
          await check(CreateServiceInvoiceDto, {
            ...validInvoice,
            customerEmail: 'ana@',
          })
        ).props,
      ).toContain('customerEmail');

      const { instance } = await check(CreateServiceInvoiceDto, {
        ...validInvoice,
        customerEmail: ' Ana@Example.TEST ',
      });
      expect(instance.customerEmail).toBe('ana@example.test');
    });

    it.each([
      ['customerName', '   '],
      ['serviceDescription', ''],
    ])('rejects a blank required %s', async (field, value) => {
      const { props } = await check(CreateServiceInvoiceDto, {
        ...validInvoice,
        [field]: value,
      });
      expect(props).toContain(field);
    });

    it.each([
      ['customerName', 150],
      ['serviceDescription', 2000],
      ['notes', 2000],
      ['serviceCode', 50],
    ])(
      'accepts %s at %i characters and rejects one more',
      async (field, max) => {
        const atLimit = await check(CreateServiceInvoiceDto, {
          ...validInvoice,
          [field]: 'a'.repeat(max),
        });
        const overLimit = await check(CreateServiceInvoiceDto, {
          ...validInvoice,
          [field]: 'a'.repeat(max + 1),
        });
        expect(atLimit.props).not.toContain(field);
        expect(overLimit.props).toContain(field);
      },
    );

    it.each([
      ['000.000.000-00', true],
      ['11.222.333/0001-81', true],
      ['1234567890', false],
      ['123456789012', false],
    ])('checks the CPF/CNPJ digit count of %s', async (document, ok) => {
      const { props } = await check(CreateServiceInvoiceDto, {
        ...validInvoice,
        customerDocument: document,
      });
      expect(props.includes('customerDocument')).toBe(!ok);
    });

    it('caps the amount at MAX_CENTS_AMOUNT', async () => {
      expect(
        (
          await check(CreateServiceInvoiceDto, {
            ...validInvoice,
            amountCents: MAX_CENTS_AMOUNT,
          })
        ).props,
      ).toEqual([]);
      expect(
        (
          await check(CreateServiceInvoiceDto, {
            ...validInvoice,
            amountCents: MAX_CENTS_AMOUNT + 1,
          })
        ).props,
      ).toContain('amountCents');
    });
  });

  describe('UpdateServiceInvoiceDto', () => {
    it('treats a blank optional field as absent (unchanged)', async () => {
      const { props, instance } = await check(UpdateServiceInvoiceDto, {
        customerEmail: '',
        notes: '   ',
      });
      expect(props).toEqual([]);
      expect(instance.customerEmail).toBeUndefined();
      expect(instance.notes).toBeUndefined();
    });

    it.each([
      'customerDocument',
      'customerEmail',
      'customerPhone',
      'serviceCode',
      'notes',
    ])('accepts null to clear %s', async (field) => {
      const { props, instance } = await check(UpdateServiceInvoiceDto, {
        [field]: null,
      });
      expect(props).toEqual([]);
      expect(
        (instance as unknown as Record<string, unknown>)[field],
      ).toBeNull();
    });

    it('leaves absent fields undefined (unchanged)', async () => {
      const { instance } = await check(UpdateServiceInvoiceDto, {});
      expect(instance.customerEmail).toBeUndefined();
    });

    it.each([
      'customerName',
      'serviceDescription',
      'amountCents',
      'competenceDate',
    ])('refuses null for the required %s', async (field) => {
      const { props } = await check(UpdateServiceInvoiceDto, {
        [field]: null,
      });
      expect(props).toContain(field);
    });
  });

  describe('CancelInvoiceDto', () => {
    it('requires a non-blank reason of at most 500 characters', async () => {
      expect(
        (await check(CancelInvoiceDto, { reason: '   ' })).props,
      ).toContain('reason');
      expect(
        (await check(CancelInvoiceDto, { reason: 'a'.repeat(500) })).props,
      ).toEqual([]);
      expect(
        (await check(CancelInvoiceDto, { reason: 'a'.repeat(501) })).props,
      ).toContain('reason');
    });
  });
});

describe('UpsertFiscalProfileDto validation', () => {
  it('accepts a masked profile and normalises document, CEP and UF', async () => {
    const { props, instance } = await check(
      UpsertFiscalProfileDto,
      validProfile,
    );
    expect(props).toEqual([]);
    expect(instance.documentNumber).toBe('11222333000181');
    expect(instance.addressZipCode).toBe('70000000');
    expect(instance.addressState).toBe('DF');
  });

  it('rejects a blank legal name', async () => {
    const { props } = await check(UpsertFiscalProfileDto, {
      ...validProfile,
      legalName: '  ',
    });
    expect(props).toContain('legalName');
  });

  it.each([
    ['documentNumber', '11.222.333/0001'],
    ['addressZipCode', '7000-000'],
    ['addressState', 'XX'],
    ['cityIbgeCode', '355030'],
  ])('rejects an invalid %s', async (field, value) => {
    const { props } = await check(UpsertFiscalProfileDto, {
      ...validProfile,
      [field]: value,
    });
    expect(props).toContain(field);
  });

  // Product decision: a fiscal profile may be saved as an incomplete draft,
  // so CEP and UF may be blank. The issue boundary enforces completeness.
  it.each([
    ['blank', ''],
    ['whitespace', '  '],
    ['null', null],
    ['absent', undefined],
  ])('accepts a %s CEP and UF on a draft, stored as empty', async (_c, v) => {
    const { props, instance } = await check(UpsertFiscalProfileDto, {
      ...validProfile,
      addressZipCode: v,
      addressState: v,
    });
    expect(props).toEqual([]);
    expect(instance.addressZipCode).toBe('');
    expect(instance.addressState).toBe('');
  });

  it.each(['fiscalProvider', 'fiscalProviderMode'])(
    'rejects client-provided %s, since provider routing is server configuration',
    async (field) => {
      const instance = plainToInstance(UpsertFiscalProfileDto, {
        ...validProfile,
        [field]: field === 'fiscalProvider' ? 'FOCUS_NFE' : 'PRODUCTION',
      });
      // Same options as the global ValidationPipe (bootstrap/configure-app.ts).
      const errors = await validate(instance, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      expect(errors.map((error) => error.property)).toEqual([field]);
    },
  );

  it('accepts a 7-digit IBGE code', async () => {
    const { props } = await check(UpsertFiscalProfileDto, {
      ...validProfile,
      cityIbgeCode: '5300108',
    });
    expect(props).toEqual([]);
  });

  it('stores a blank optional field as null so the upsert clears it', async () => {
    const { props, instance } = await check(UpsertFiscalProfileDto, {
      ...validProfile,
      tradeName: '',
      addressComplement: '  ',
    });
    expect(props).toEqual([]);
    expect(instance.tradeName).toBeNull();
    expect(instance.addressComplement).toBeNull();
  });

  it('limits the ISS rate to two decimal places', async () => {
    expect(
      (await check(UpsertFiscalProfileDto, { ...validProfile, issRate: 2.5 }))
        .props,
    ).toEqual([]);
    expect(
      (await check(UpsertFiscalProfileDto, { ...validProfile, issRate: 2.555 }))
        .props,
    ).toContain('issRate');
  });

  it.each([
    ['legalName', 150],
    ['addressStreet', 200],
    ['addressComplement', 100],
    ['municipalRegistration', 30],
  ])('accepts %s at %i characters and rejects one more', async (field, max) => {
    const atLimit = await check(UpsertFiscalProfileDto, {
      ...validProfile,
      [field]: 'a'.repeat(max),
    });
    const overLimit = await check(UpsertFiscalProfileDto, {
      ...validProfile,
      [field]: 'a'.repeat(max + 1),
    });
    expect(atLimit.props).not.toContain(field);
    expect(overLimit.props).toContain(field);
  });
});
