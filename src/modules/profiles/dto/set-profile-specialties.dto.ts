import { IsArray, IsString, MaxLength } from 'class-validator';
import { MAX_ID_LENGTH } from '../../../common/validators/input-validation.decorators';

export class SetProfileSpecialtiesDto {
  @IsArray()
  @IsString({ each: true })
  @MaxLength(MAX_ID_LENGTH, { each: true })
  specialtyIds!: string[];
}
