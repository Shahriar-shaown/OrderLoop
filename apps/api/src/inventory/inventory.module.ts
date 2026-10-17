import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller.js';
import { InventoryService, StockRunner } from './inventory.service.js';
import { ReservationsService } from './reservations.service.js';

@Module({
  controllers: [InventoryController],
  providers: [StockRunner, InventoryService, ReservationsService],
})
export class InventoryModule {}
