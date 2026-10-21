import { Inject, Injectable, Logger } from '@nestjs/common';
import { enqueueNewOrder, type JobQueue } from '@orderloop/automation';
import { AUTOMATION_QUEUE } from '../queue/queue.module.js';

/**
 * What the rest of the API tells automation. Never throws: automation must not be able to fail the thing it reacts to.
 */
@Injectable()
export class AutomationEvents {
  private readonly logger = new Logger(AutomationEvents.name);

  constructor(@Inject(AUTOMATION_QUEUE) private readonly queue: JobQueue) {}

  /**
   * An order was committed. Queues a `neworder__<orderId>` evaluation (deterministic id, so a retried create queues it once).
   * If the queue is down the order is still created; the five-minute catch-up scan of the NEW_ORDER rule announces it later.
   */
  async orderCreated(tenantId: string, orderId: string): Promise<void> {
    const queued = await enqueueNewOrder(this.queue, tenantId, orderId);
    if (!queued)
      this.logger.warn(
        `new-order event not queued (order ${orderId}); the catch-up scan will announce it`,
      );
  }
}
