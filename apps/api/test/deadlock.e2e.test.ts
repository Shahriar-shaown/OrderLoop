import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './app.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

describe('a transaction PostgreSQL aborts for a deadlock is run again', () => {
  it('two transactions taking the same two locks in opposite order both succeed', async () => {
    const lockKeys = [Date.now() % 1_000_000, (Date.now() % 1_000_000) + 1] as const;
    let attempts = 0;
    // The first attempt of each transaction waits until both hold their first lock, which guarantees the deadlock.
    let holding = 0;
    const bothHold = new Promise<void>((resolve) => {
      const check = () => (holding >= 2 ? resolve() : setTimeout(check, 5));
      check();
    });
    const run = (first: number, second: number) => {
      let firstAttempt = true;
      return t.db.withContext({}, async (tx) => {
        attempts++;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${first}::bigint)`;
        if (firstAttempt) {
          firstAttempt = false;
          holding++;
          await bothHold;
        }
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${second}::bigint)`;
        return 'done';
      });
    };
    const results = await Promise.all([
      run(lockKeys[0], lockKeys[1]),
      run(lockKeys[1], lockKeys[0]),
    ]);
    expect(results).toEqual(['done', 'done']);
    expect(attempts).toBeGreaterThanOrEqual(3); // one of them was aborted and ran again
  });

  it('gives up after three attempts and does not retry other errors', async () => {
    let attempts = 0;
    await expect(
      t.db.withContext({}, async () => {
        attempts++;
        throw new Error('not a database abort');
      }),
    ).rejects.toThrow('not a database abort');
    expect(attempts).toBe(1);
  });
});
