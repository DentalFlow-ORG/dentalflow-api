import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { ClinicalDictationService } from './clinical-dictation.service';
import { ClinicalRecordsController } from './clinical-records.controller';
import { ClinicalRecordsService } from './clinical-records.service';

@Module({
  imports: [PrismaModule, CommonModule],
  controllers: [ClinicalRecordsController],
  providers: [ClinicalRecordsService, ClinicalDictationService],
  exports: [ClinicalRecordsService],
})
export class ClinicalRecordsModule {}
