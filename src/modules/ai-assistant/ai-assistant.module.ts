import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { FinanceModule } from '../finance/finance.module';
import { StockModule } from '../stock/stock.module';
import { FinanceContextBuilder } from './builders/finance-context.builder';
import { InventoryContextBuilder } from './builders/inventory-context.builder';
import { AiAssistantController } from './ai-assistant.controller';
import { AiAssistantService } from './ai-assistant.service';

@Module({
  imports: [PrismaModule, CommonModule, FinanceModule, StockModule],
  controllers: [AiAssistantController],
  providers: [AiAssistantService, FinanceContextBuilder, InventoryContextBuilder],
})
export class AiAssistantModule {}
