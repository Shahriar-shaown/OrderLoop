import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { FinanceController } from './finance.controller.js';
import { FinanceService } from './finance.service.js';
import { SettlementsService } from './settlements.service.js';

@Module({
  imports: [AuditModule],
  controllers: [FinanceController],
  providers: [SettlementsService, FinanceService],
})
export class FinanceModule {}
