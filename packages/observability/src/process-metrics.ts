import { readdirSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Registry } from './registry.js';

const START_SECONDS = Date.now() / 1000 - process.uptime();

/** Standard process metrics (Prometheus naming, so common dashboards work) plus a build-info series. No request data, nothing user-specific. */
export function registerProcessMetrics(
  registry: Registry,
  info: { service: string; version?: string },
): { stop: () => void } {
  const cpu = registry.collectedCounter({
    name: 'process_cpu_seconds_total',
    help: 'Total user and system CPU time spent, in seconds',
    labelNames: ['mode'],
  });
  cpu.setCollector((g) => {
    const u = process.cpuUsage();
    g.set({ mode: 'user' }, u.user / 1e6);
    g.set({ mode: 'system' }, u.system / 1e6);
  });
  const mem = registry.gauge({
    name: 'process_resident_memory_bytes',
    help: 'Resident memory size in bytes',
  });
  mem.setCollector((g) => g.set({}, process.memoryUsage().rss));
  const heap = registry.gauge({
    name: 'nodejs_heap_size_bytes',
    help: 'V8 heap size in bytes',
    labelNames: ['kind'],
  });
  heap.setCollector((g) => {
    const m = process.memoryUsage();
    g.set({ kind: 'used' }, m.heapUsed);
    g.set({ kind: 'total' }, m.heapTotal);
    g.set({ kind: 'external' }, m.external);
  });
  const start = registry.gauge({
    name: 'process_start_time_seconds',
    help: 'Start time of the process since the Unix epoch, in seconds',
  });
  start.setCollector((g) => g.set({}, START_SECONDS));
  const fds = registry.gauge({
    name: 'process_open_fds',
    help: 'Number of open file descriptors (Linux only)',
  });
  fds.setCollector((g) => {
    try {
      g.set({}, readdirSync('/proc/self/fd').length);
    } catch {
      // not Linux: the series is simply absent
    }
  });
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  const lag = registry.gauge({
    name: 'nodejs_eventloop_lag_seconds',
    help: 'Event loop delay since the previous scrape',
    labelNames: ['quantile'],
  });
  lag.setCollector((g) => {
    g.set({ quantile: '0.5' }, delay.percentile(50) / 1e9);
    g.set({ quantile: '0.99' }, delay.percentile(99) / 1e9);
    g.set({ quantile: '1' }, delay.max / 1e9);
    delay.reset();
  });
  const build = registry.gauge({
    name: 'orderloop_build_info',
    help: 'Constant 1; the labels say which service and which Node.js runs it',
    labelNames: ['service', 'version', 'node'],
  });
  build.setCollector((g) =>
    g.set({ service: info.service, version: info.version ?? 'unknown', node: process.version }, 1),
  );
  return { stop: () => delay.disable() };
}
