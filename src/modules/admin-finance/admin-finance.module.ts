import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminFinanceController } from './admin-finance.controller';
import { AdminFinanceService } from './admin-finance.service';

@Module({
  imports: [PrismaModule, CommonModule],
  controllers: [AdminFinanceController],
  providers: [AdminFinanceService],
})
export class AdminFinanceModule {}
