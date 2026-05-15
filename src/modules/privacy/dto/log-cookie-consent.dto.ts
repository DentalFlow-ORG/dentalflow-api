import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CookieConsentCategoriesDto {
  @IsBoolean()
  necessary!: boolean;

  @IsBoolean()
  preferences!: boolean;

  @IsBoolean()
  analytics!: boolean;

  @IsBoolean()
  marketing!: boolean;
}

export class LogCookieConsentDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  anonymousId?: string;

  @IsObject()
  @ValidateNested()
  @Type(() => CookieConsentCategoriesDto)
  categories!: CookieConsentCategoriesDto;

  @IsString()
  @MaxLength(20)
  policyVersion!: string;

  @IsIn(['banner', 'preferences'])
  source!: 'banner' | 'preferences';
}
