import { Registry, registerProcessMetrics, type Gauge } from '@orderloop/observability';
import type { HealthDeps } from './health-server.js';
import { probeWorker } from './health-server.js';

/** The slice of a BullMQ Worker the instrumentation uses. */
export interface WorkerLike {
  on(event: 'completed', fn: (job: JobTimes) => void): unknown;
  on(event: 'failed', fn: (job: JobTimes | undefined, err: Error) => void): unknown;
}
interface JobTimes {
  processedOn?: number | undefined;
  finishedOn?: number | undefined;
}

export const JOB_BUCKETS = [0.01, 0.05, 0.25, 1, 5, 15, 60, 300];

/** Metrics of the worker process: process stats, dependency health, heartbeat age, jobs processed per queue (queue name and result only). */
export function createWorkerMetrics(
  health: Pick<HealthDeps, 'redis' | 'db' | 'lastHeartbeatAt'>,
  now: () => number = Date.now,
) {
  const registry = new Registry();
  const handle = registerProcessMetrics(registry, { service: 'orderloop-worker' });
  const jobs = registry.counter({
    name: 'orderloop_worker_jobs_total',
    help: 'Job attempts finished by this worker process, by queue and result (a failed attempt may be retried)',
    labelNames: ['queue', 'result'],
  });
  const duration = registry.histogram({
    name: 'orderloop_worker_job_duration_seconds',
    help: 'Time this worker process spent on a job attempt, by queue',
    labelNames: ['queue'],
    buckets: JOB_BUCKETS,
  });
  const age: Gauge = registry.gauge({
    name: 'orderloop_worker_own_heartbeat_age_seconds',
    help: 'Seconds since this process last wrote its heartbeat to Redis; absent before the first one',
  });
  age.setCollector((g) => {
    const last = health.lastHeartbeatAt();
    if (last) g.set({}, Math.max(0, (now() - last.getTime()) / 1000));
  });
  const up = registry.gauge({
    name: 'orderloop_worker_ready',
    help: '1 when the worker readiness probe passes, else 0, per check',
    labelNames: ['check'],
  });
  up.setCollector(async (g) => {
    const { checks } = await probeWorker({
      ...health,
      registry,
      metricsToken: undefined,
      now,
    });
    for (const [check, status] of Object.entries(checks)) g.set({ check }, status === 'up' ? 1 : 0);
  });

  return {
    registry,
    stop: handle.stop,
    instrument(queue: string, worker: WorkerLike): void {
      const seconds = (j?: JobTimes) =>
        j?.processedOn && j.finishedOn
          ? Math.max(0, (j.finishedOn - j.processedOn) / 1000)
          : undefined;
      worker.on('completed', (job) => {
        jobs.inc({ queue, result: 'completed' });
        const s = seconds(job);
        if (s !== undefined) duration.observe({ queue }, s);
      });
      worker.on('failed', (job) => {
        jobs.inc({ queue, result: 'failed' });
        const s = seconds(job);
        if (s !== undefined) duration.observe({ queue }, s);
      });
    },
  };
}
