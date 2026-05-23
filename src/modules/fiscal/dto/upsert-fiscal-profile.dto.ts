import {
  FiscalDocumentType,
  FiscalProvider,
  FiscalProviderMode,
  FiscalTaxRegime,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

export class UpsertFiscalProfileDto {
  @IsString({ message: 'Razão social é obrigatória.' })
  legalName!: string;

  @IsOptional()
  @IsString({ message: 'Nome fantasia deve ser um texto.' })
  tradeName?: string;

  @IsEnum(FiscalDocumentType, { message: 'Tipo de documento fiscal inválido.' })
  documentType!: FiscalDocumentType;

  @IsString({ message: 'CNPJ/CPF é obrigatório.' })
  documentNumber!: string;

  @IsOptional()
  @IsString({ message: 'Inscrição municipal deve ser um texto.' })
  municipalRegistration?: string;

  @IsOptional()
  @IsString({ message: 'Inscrição estadual deve ser um texto.' })
  stateRegistration?: string;

  @IsEnum(FiscalTaxRegime, { message: 'Regime tributário inválido.' })
  taxRegime!: FiscalTaxRegime;

  @IsOptional()
  @IsString({ message: 'Regime tributário especial deve ser um texto.' })
  specialTaxRegime?: string;

  @IsOptional()
  @IsString({ message: 'Código de serviço deve ser um texto.' })
  serviceCode?: string;

  @IsOptional()
  @IsString({ message: 'CNAE deve ser um texto.' })
  cnae?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'Alíquota de ISS deve ser um número.' })
  @Min(0, { message: 'Alíquota de ISS não pode ser negativa.' })
  @Max(100, { message: 'Alíquota de ISS não pode ser maior que 100%.' })
  issRate?: number;

  @IsString({ message: 'Rua é obrigatória.' })
  addressStreet!: string;

  @IsString({ message: 'Número do endereço é obrigatório.' })
  addressNumber!: string;

  @IsOptional()
  @IsString({ message: 'Complemento deve ser um texto.' })
  addressComplement?: string;

  @IsString({ message: 'Bairro é obrigatório.' })
  addressNeighborhood!: string;

  @IsString({ message: 'Cidade é obrigatória.' })
  addressCity!: string;

  @IsString({ message: 'UF é obrigatória.' })
  @Length(2, 2, { message: 'UF deve ter exatamente 2 caracteres.' })
  addressState!: string;

  @IsString({ message: 'CEP é obrigatório.' })
  addressZipCode!: string;

  @IsOptional()
  @IsString({ message: 'Código IBGE do município deve ser um texto.' })
  cityIbgeCode?: string;

  @IsOptional()
  @IsEnum(FiscalProvider, { message: 'Provedor fiscal inválido.' })
  fiscalProvider?: FiscalProvider;

  @IsOptional()
  @IsEnum(FiscalProviderMode, { message: 'Modo do provedor fiscal inválido.' })
  fiscalProviderMode?: FiscalProviderMode;
}
