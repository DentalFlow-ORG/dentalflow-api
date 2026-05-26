import { Module } from '@nestjs/common';
import { StockController } from './stock.controller';
import { StockService } from './stock.service';
import { StockPurchaseListService } from './stock-purchase-list.service';

@Module({
  controllers: [StockController],
  providers: [StockService, StockPurchaseListService],
  exports: [StockService, StockPurchaseListService],
})
export class StockModule {}
