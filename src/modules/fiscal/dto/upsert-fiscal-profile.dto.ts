import { FiscalDocumentType, FiscalTaxRegime } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  blankToNull,
  digitsOnly,
  trimValue,
} from '../../../common/utils/transform.helpers';
import {
  BRAZILIAN_UFS,
  CEP_DIGITS_PATTERN,
  IBGE_CITY_CODE_PATTERN,
} from '../../../common/validators/br-field-patterns';

// A profile may be saved incomplete (product decision): address fields accept
// blank values so nobody has to invent data just to save a draft. Filled values
// are still validated. Completeness is enforced where it matters — the profile
// is only `isConfigured` once every required field is valid, and invoices
// cannot be marked ready or simulated until then (FiscalService).
const NAME_MAX = 150;
const REGISTRATION_MAX = 30;
const TAX_TEXT_MAX = 50;
const STREET_MAX = 200;
const ADDRESS_NUMBER_MAX = 20;
const COMPLEMENT_MAX = 100;
const NEIGHBORHOOD_MAX = 100;
const CITY_MAX = 100;

const trim = ({ value }: { value: unknown }) => trimValue(value);
// The upsert writes the whole profile, so a blank optional field is stored as
// null (cleared) rather than dropped, which would keep the previous value.
const blank = ({ value }: { value: unknown }) => blankToNull(value);
const digits = ({ value }: { value: unknown }) => digitsOnly(value);
// CEP and UF columns are non-null: blank or null is stored as '' (not filled).
const blankToEmpty = (value: unknown) =>
  value === null || value === undefined ? '' : value;
const isFilled = (_: unknown, value: unknown) => value !== '';

export class UpsertFiscalProfileDto {
  @Transform(trim)
  @IsString({ message: 'Razão social é obrigatória.' })
  @IsNotEmpty({ message: 'Razão social é obrigatória.' })
  @MaxLength(NAME_MAX, {
    message: 'Razão social deve ter no máximo 150 caracteres.',
  })
  legalName!: string;

  @Transform(blank)
  @IsOptional()
  @IsString({ message: 'Nome fantasia deve ser um texto.' })
  @MaxLength(NAME_MAX, {
    message: 'Nome fantasia deve ter no máximo 150 caracteres.',
  })
  tradeName?: string | null;

  @IsEnum(FiscalDocumentType, { message: 'Tipo de documento fiscal inválido.' })
  documentType!: FiscalDocumentType;

  // CPF (11) or CNPJ (14) digits — the schema keeps both document types. The
  // mask is stripped first; the checksum still only gates `isConfigured`.
  @Transform(digits)
  @IsString({ message: 'CNPJ/CPF é obrigatório.' })
  @Matches(/^(\d{11}|\d{14})$/, {
    message: 'Informe um CNPJ com 14 dígitos (ou CPF com 11 dígitos).',
  })
  documentNumber!: string;

  @Transform(blank)
  @IsOptional()
  @IsString({ message: 'Inscrição municipal deve ser um texto.' })
  @MaxLength(REGISTRATION_MAX, {
    message: 'Inscrição municipal deve ter no máximo 30 caracteres.',
  })
  municipalRegistration?: string | null;

  @Transform(blank)
  @IsOptional()
  @IsString({ message: 'Inscrição estadual deve ser um texto.' })
  @MaxLength(REGISTRATION_MAX, {
    message: 'Inscrição estadual deve ter no máximo 30 caracteres.',
  })
  stateRegistration?: string | null;

  @IsEnum(FiscalTaxRegime, { message: 'Regime tributário inválido.' })
  taxRegime!: FiscalTaxRegime;

  @Transform(blank)
  @IsOptional()
  @IsString({ message: 'Regime tributário especial deve ser um texto.' })
  @MaxLength(TAX_TEXT_MAX, {
    message: 'Regime tributário especial deve ter no máximo 50 caracteres.',
  })
  specialTaxRegime?: string | null;

  @Transform(blank)
  @IsOptional()
  @IsString({ message: 'Código de serviço deve ser um texto.' })
  @MaxLength(TAX_TEXT_MAX, {
    message: 'Código de serviço deve ter no máximo 50 caracteres.',
  })
  serviceCode?: string | null;

  @Transform(blank)
  @IsOptional()
  @IsString({ message: 'CNAE deve ser um texto.' })
  @MaxLength(TAX_TEXT_MAX, {
    message: 'CNAE deve ter no máximo 50 caracteres.',
  })
  cnae?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'Alíquota de ISS deve ter no máximo 2 casas decimais.' },
  )
  @Min(0, { message: 'Alíquota de ISS não pode ser negativa.' })
  @Max(100, { message: 'Alíquota de ISS não pode ser maior que 100%.' })
  issRate?: number;

  @Transform(trim)
  @IsString({ message: 'Rua é obrigatória.' })
  @MaxLength(STREET_MAX, { message: 'Rua deve ter no máximo 200 caracteres.' })
  addressStreet!: string;

  @Transform(trim)
  @IsString({ message: 'Número do endereço é obrigatório.' })
  @MaxLength(ADDRESS_NUMBER_MAX, {
    message: 'Número do endereço deve ter no máximo 20 caracteres.',
  })
  addressNumber!: string;

  @Transform(blank)
  @IsOptional()
  @IsString({ message: 'Complemento deve ser um texto.' })
  @MaxLength(COMPLEMENT_MAX, {
    message: 'Complemento deve ter no máximo 100 caracteres.',
  })
  addressComplement?: string | null;

  @Transform(trim)
  @IsString({ message: 'Bairro é obrigatório.' })
  @MaxLength(NEIGHBORHOOD_MAX, {
    message: 'Bairro deve ter no máximo 100 caracteres.',
  })
  addressNeighborhood!: string;

  @Transform(trim)
  @IsString({ message: 'Cidade é obrigatória.' })
  @MaxLength(CITY_MAX, {
    message: 'Cidade deve ter no máximo 100 caracteres.',
  })
  addressCity!: string;

  @Transform(({ value }: { value: unknown }) => {
    const state = blankToEmpty(value);
    return typeof state === 'string' ? state.trim().toUpperCase() : state;
  })
  @IsString({ message: 'UF deve ser um texto.' })
  @ValidateIf(isFilled)
  @IsIn(BRAZILIAN_UFS, { message: 'Informe uma UF válida (ex: SP, RJ).' })
  addressState!: string;

  @Transform(({ value }: { value: unknown }) => digitsOnly(blankToEmpty(value)))
  @IsString({ message: 'CEP deve ser um texto.' })
  @ValidateIf(isFilled)
  @Matches(CEP_DIGITS_PATTERN, { message: 'CEP deve ter 8 dígitos.' })
  addressZipCode!: string;

  @Transform(blank)
  @IsOptional()
  @IsString({ message: 'Código IBGE do município deve ser um texto.' })
  @Matches(IBGE_CITY_CODE_PATTERN, {
    message: 'Código IBGE do município deve ter 7 dígitos.',
  })
  cityIbgeCode?: string | null;

  // Provider routing (fiscalProvider / fiscalProviderMode) is deliberately not
  // part of this client-writable DTO: it is server configuration (see
  // config/fiscal.config.ts). The global ValidationPipe rejects those keys.
}
