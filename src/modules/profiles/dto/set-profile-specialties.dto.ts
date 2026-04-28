import { IsArray, IsString } from 'class-validator';

export class SetProfileSpecialtiesDto {
  @IsArray()
  @IsString({ each: true })
  specialtyIds!: string[];
}
