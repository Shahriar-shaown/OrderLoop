import { Inject, Injectable } from '@nestjs/common';
import { channelAvailability, type EvaluateDeps, type Queues } from '@orderloop/automation';
import { Database } from '@orderloop/db';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';
import { LOGGER } from '../logging/tokens.js';
import type { Logger as Pino } from '../logging/logger.js';
import { AUTOMATION_QUEUE, DELIVERY_QUEUE } from '../queue/queue.module.js';

/** The clock the automation services read; tests replace it to make time stand still or jump. */
export const AUTOMATION_NOW = Symbol('AUTOMATION_NOW');
export type Now = () => Date;

/**
 * Everything the shared automation engine needs, wired to this process: the database, the two queues, the clock, the
 * structured logger and which messaging channels this server has. The API uses it to evaluate a rule on demand and to
 * retry; the worker builds the same thing from its own connections.
 */
@Injectable()
export class AutomationRuntime {
  readonly deps: EvaluateDeps;
  readonly queues: Queues;
  readonly channels: { sms: boolean; whatsapp: boolean };

  constructor(
    db: Database,
    @Inject(APP_CONFIG) readonly config: AppConfig,
    @Inject(AUTOMATION_QUEUE) evaluate: Queues['evaluate'],
    @Inject(DELIVERY_QUEUE) deliver: Queues['deliver'],
    @Inject(AUTOMATION_NOW) readonly now: Now,
    @Inject(LOGGER) logger: Pino,
  ) {
    this.queues = { evaluate, deliver };
    this.channels = channelAvailability({
      smsProvider: config.SMS_PROVIDER,
      whatsappProvider: config.WHATSAPP_PROVIDER,
    });
    this.deps = {
      db,
      queues: this.queues,
      now,
      providers: this.channels,
      log: ({ level = 'info', ...event }) => logger[level](event, event.event),
    };
  }
}
