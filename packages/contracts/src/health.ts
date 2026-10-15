import { z } from 'zod';

export const DependencyStatus = z.enum(['up', 'down']);
export type DependencyStatus = z.infer<typeof DependencyStatus>;

export const LiveResponse = z.object({ status: z.literal('ok') });
export type LiveResponse = z.infer<typeof LiveResponse>;

export const ReadyResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  checks: z.object({ postgres: DependencyStatus, redis: DependencyStatus }),
});
export type ReadyResponse = z.infer<typeof ReadyResponse>;
