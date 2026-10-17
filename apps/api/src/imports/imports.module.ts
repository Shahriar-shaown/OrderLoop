import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ImportsController } from './imports.controller.js';
import { ImportsService } from './imports.service.js';

@Module({ imports: [AuditModule], controllers: [ImportsController], providers: [ImportsService] })
export class ImportsModule {}
