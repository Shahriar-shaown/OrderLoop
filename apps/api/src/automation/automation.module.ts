import { Global, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AutomationController } from './automation.controller.js';
import { AutomationEvents } from './automation-events.service.js';
import { AUTOMATION_NOW, AutomationRuntime } from './automation.runtime.js';
import { AutomationService } from './automation.service.js';
import { NotificationsService } from './notifications.service.js';

@Global()
@Module({
  imports: [AuditModule],
  controllers: [AutomationController],
  providers: [
    { provide: AUTOMATION_NOW, useValue: () => new Date() },
    AutomationRuntime,
    AutomationService,
    NotificationsService,
    AutomationEvents,
  ],
  exports: [AutomationEvents, AutomationRuntime],
})
export class AutomationModule {}
