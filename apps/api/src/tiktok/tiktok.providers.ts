import { Logger } from '@nestjs/common';
import { type Logger as LogFn, type TikTokMetrics } from '@orderloop/automation';

/** Tests replace it to see what the shared code reports (counters). Production: the API's Prometheus registry. */
export const TIKTOK_METRICS = Symbol('TIKTOK_METRICS');

/** Nest's logger as the shared code's structured logger: one JSON line per event (ids and words only, never a token or buyer data). */
export function toLogFn(logger: Logger): LogFn {
  return (e) => {
    const line = JSON.stringify(e);
    if (e.level === 'error') logger.error(line);
    else if (e.level === 'warn') logger.warn(line);
    else logger.log(line);
  };
}

export type { TikTokMetrics };
