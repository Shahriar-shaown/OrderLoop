import type { Registry } from './registry.js';

/** The slice of a BullMQ Queue the collector reads (so tests need no Redis). */
export interface QueueLike {
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
  getWaiting(start: number, end: number): Promise<{ timestamp?: number | undefined }[]>;
}

export const QUEUE_STATES = ['waiting', 'active', 'delayed', 'failed', 'paused'] as const;

/**
 * Per queue: how many jobs are in each state and how old the oldest waiting job is. BullMQ keeps these counts in Redis, so
 * they cover every process that uses the queue. A failed job is one that used all its attempts (kept for a week), so on the
 * automation queues `failed` is "automation runs / deliveries that gave up".
 */
export function registerQueueMetrics(
  registry: Registry,
  queues: Record<string, QueueLike>,
  options: { cacheMs?: number; timeoutMs?: number; now?: () => number } = {},
): void {
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? 5000;
  const timeoutMs = options.timeoutMs ?? 3000;
  const jobs = registry.gauge({
    name: 'orderloop_queue_jobs',
    help: 'Jobs in a BullMQ queue by state',
    labelNames: ['queue', 'state'],
  });
  const age = registry.gauge({
    name: 'orderloop_queue_oldest_waiting_age_seconds',
    help: 'Age of the oldest job waiting in a BullMQ queue (0 when none waits)',
    labelNames: ['queue'],
  });
  let cache: {
    at: number;
    counts: Record<string, Record<string, number>>;
    ages: Record<string, number>;
  } | null = null;
  const read = async () => {
    const counts: Record<string, Record<string, number>> = {};
    const ages: Record<string, number> = {};
    for (const [name, q] of Object.entries(queues)) {
      counts[name] = await q.getJobCounts(...QUEUE_STATES);
      const oldest = (await q.getWaiting(0, 0))[0];
      ages[name] = oldest?.timestamp ? Math.max(0, (now() - oldest.timestamp) / 1000) : 0;
    }
    return { at: now(), counts, ages };
  };
  let failure: { at: number; error: unknown } | null = null;
  const load = async () => {
    if (cache && now() - cache.at < cacheMs) return cache;
    // The second gauge of the same scrape must not wait out the timeout again.
    if (failure && now() - failure.at < cacheMs) throw failure.error;
    // Redis down must not hang a scrape: BullMQ queues wait for the connection to come back.
    let timer: NodeJS.Timeout | undefined;
    try {
      cache = await Promise.race([
        read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('queue stats timed out')), timeoutMs);
        }),
      ]);
    } catch (error) {
      failure = { at: now(), error };
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return cache;
  };
  jobs.setCollector(async (g) => {
    const { counts } = await load();
    for (const [queue, byState] of Object.entries(counts))
      for (const state of QUEUE_STATES) g.set({ queue, state }, byState[state] ?? 0);
  });
  age.setCollector(async (g) => {
    const { ages } = await load();
    for (const [queue, v] of Object.entries(ages)) g.set({ queue }, v);
  });
}
