import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ExportsController } from './exports.controller.js';
import { ExportsService } from './exports.service.js';

@Module({ imports: [AuditModule], controllers: [ExportsController], providers: [ExportsService] })
export class ExportsModule {}
