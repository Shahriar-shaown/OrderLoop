import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { CustomersController } from './customers.controller.js';
import { CustomersService } from './customers.service.js';
import { OrderImportController } from './order-import.controller.js';
import { OrderImportService } from './order-import.service.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';

@Module({
  imports: [AuditModule, InventoryModule],
  controllers: [OrdersController, CustomersController, OrderImportController],
  providers: [OrdersService, CustomersService, OrderImportService],
  exports: [OrdersService, CustomersService],
})
export class OrdersModule {}
