import { Module } from '@nestjs/common';
import { StockController } from './stock.controller';
import { StockService } from './stock.service';
import { StockPurchaseListService } from './stock-purchase-list.service';
import { StockAbnormalConsumptionService } from './stock-abnormal-consumption.service';

@Module({
  controllers: [StockController],
  providers: [
    StockService,
    StockPurchaseListService,
    StockAbnormalConsumptionService,
  ],
  exports: [
    StockService,
    StockPurchaseListService,
    StockAbnormalConsumptionService,
  ],
})
export class StockModule {}
