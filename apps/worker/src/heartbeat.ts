/** The key every worker process refreshes. Its value is the ISO time of the last beat; the key expires if no worker beats. */
export const HEARTBEAT_KEY = 'worker:heartbeat';
export const HEARTBEAT_EVERY_MS = 30_000;
/** Three missed beats: the key is gone, which is what `redis-cli EXISTS` / `TTL` shows. */
export const HEARTBEAT_TTL_SECONDS = 90;

/**
 * A liveness signal with no HTTP port: write the current time to Redis every 30 s. Several workers share one key (the last
 * writer wins), so a missing key means no worker is alive, or Redis itself is not reachable. A failed write is logged and the
 * next beat tries again. Returns a function that stops it.
 */
export function startHeartbeat(deps: {
  redis: { set: (key: string, value: string, mode: 'EX', seconds: number) => Promise<unknown> };
  now?: () => Date;
  log: (message: string) => void;
  everyMs?: number;
  /** Test hook: replaces setInterval. */
  schedule?: (fn: () => void, ms: number) => { stop: () => void };
}): { beat: () => Promise<void>; stop: () => void } {
  const now = deps.now ?? (() => new Date());
  const beat = async () => {
    try {
      await deps.redis.set(HEARTBEAT_KEY, now().toISOString(), 'EX', HEARTBEAT_TTL_SECONDS);
    } catch (e) {
      deps.log(`heartbeat write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const every = deps.everyMs ?? HEARTBEAT_EVERY_MS;
  const timer = deps.schedule
    ? deps.schedule(() => void beat(), every)
    : (() => {
        const id = setInterval(() => void beat(), every);
        id.unref?.();
        return { stop: () => clearInterval(id) };
      })();
  void beat();
  return { beat, stop: timer.stop };
}
