import { Module } from '@nestjs/common';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';
import { ProcedureMarginsController } from './procedure-margins.controller';
import { ProcedureMarginsService } from './procedure-margins.service';

@Module({
  controllers: [FinanceController, ProcedureMarginsController],
  providers: [FinanceService, ProcedureMarginsService],
  exports: [FinanceService],
})
export class FinanceModule {}
