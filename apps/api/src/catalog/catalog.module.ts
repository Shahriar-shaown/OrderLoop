import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CatalogController } from './catalog.controller.js';
import { CategoriesService } from './categories.service.js';
import { LocationsService } from './locations.service.js';
import { SuppliersService } from './suppliers.service.js';
import { ProductsService } from './products.service.js';

@Module({
  imports: [AuditModule],
  controllers: [CatalogController],
  providers: [CategoriesService, ProductsService, LocationsService, SuppliersService],
})
export class CatalogModule {}
