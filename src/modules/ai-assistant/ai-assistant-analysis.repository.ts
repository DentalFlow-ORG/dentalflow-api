import { Injectable } from '@nestjs/common';
import {
  AiAssistantAnalysisStatus,
  AiAssistantAnalysisType,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AiAssistantAnalysisRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Returns the most recent SUCCESS record for the clinic/type, or null. */
  findLatest(clinicId: string, type: AiAssistantAnalysisType) {
    return this.prisma.aiAssistantAnalysis.findFirst({
      where: { clinicId, type, status: AiAssistantAnalysisStatus.SUCCESS },
      orderBy: { generatedAt: 'desc' },
    });
  }

  saveSuccess(data: {
    clinicId: string;
    userId: string;
    type: AiAssistantAnalysisType;
    content: object;
    model: string;
    generatedAt: Date;
    periodStart: Date | null;
    periodEnd: Date | null;
  }) {
    return this.prisma.aiAssistantAnalysis.create({
      data: {
        clinicId: data.clinicId,
        userId: data.userId,
        type: data.type,
        status: AiAssistantAnalysisStatus.SUCCESS,
        content: data.content,
        model: data.model,
        generatedAt: data.generatedAt,
        periodStart: data.periodStart,
        periodEnd: data.periodEnd,
      },
    });
  }

  /** Saves a sanitized error record — never includes secrets or full payloads. */
  saveError(data: {
    clinicId: string;
    userId: string;
    type: AiAssistantAnalysisType;
    model: string;
    errorMessage: string;
  }) {
    return this.prisma.aiAssistantAnalysis.create({
      data: {
        clinicId: data.clinicId,
        userId: data.userId,
        type: data.type,
        status: AiAssistantAnalysisStatus.ERROR,
        model: data.model,
        generatedAt: new Date(),
        errorMessage: data.errorMessage.slice(0, 500),
      },
    });
  }
}
