import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { FinanceModule } from '../finance/finance.module';
import { StockModule } from '../stock/stock.module';
import { FinanceContextBuilder } from './builders/finance-context.builder';
import { InventoryContextBuilder } from './builders/inventory-context.builder';
import { AiAssistantAnalysisRepository } from './ai-assistant-analysis.repository';
import { AiAssistantController } from './ai-assistant.controller';
import { AiAssistantHealthController } from './ai-assistant-health.controller';
import { AiAssistantService } from './ai-assistant.service';
import { AiQuotaService } from './ai-quota.service';
import { StockCopilotController } from './stock-copilot.controller';
import { StockCopilotService } from './stock-copilot.service';
import { AbnormalConsumptionCopilotController } from './abnormal-consumption-copilot.controller';
import { AbnormalConsumptionCopilotService } from './abnormal-consumption-copilot.service';
import { ExpenseClassifierController } from './expense-classifier.controller';
import { ExpenseClassifierService } from './expense-classifier.service';
import { MonthlyFinanceDiagnosisController } from './monthly-finance-diagnosis.controller';
import { MonthlyFinanceDiagnosisService } from './monthly-finance-diagnosis.service';

@Module({
  imports: [PrismaModule, CommonModule, FinanceModule, StockModule],
  controllers: [
    AiAssistantController,
    AiAssistantHealthController,
    StockCopilotController,
    AbnormalConsumptionCopilotController,
    ExpenseClassifierController,
    MonthlyFinanceDiagnosisController,
  ],
  providers: [
    AiAssistantService,
    AiAssistantAnalysisRepository,
    AiQuotaService,
    FinanceContextBuilder,
    InventoryContextBuilder,
    StockCopilotService,
    AbnormalConsumptionCopilotService,
    ExpenseClassifierService,
    MonthlyFinanceDiagnosisService,
  ],
})
export class AiAssistantModule {}
