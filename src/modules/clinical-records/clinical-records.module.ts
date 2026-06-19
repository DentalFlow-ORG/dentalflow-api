import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AiAssistantAnalysisRepository } from '../ai-assistant/ai-assistant-analysis.repository';
import { AiQuotaService } from '../ai-assistant/ai-quota.service';
import { ClinicalDictationService } from './clinical-dictation.service';
import { ClinicalRecordsController } from './clinical-records.controller';
import { ClinicalRecordsService } from './clinical-records.service';

@Module({
  imports: [PrismaModule, CommonModule],
  controllers: [ClinicalRecordsController],
  providers: [
    ClinicalRecordsService,
    ClinicalDictationService,
    AiQuotaService,
    AiAssistantAnalysisRepository,
  ],
  exports: [ClinicalRecordsService],
})
export class ClinicalRecordsModule {}
