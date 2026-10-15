// Measures what the tenant-scoped transaction costs per query (BEGIN + set_config + query + COMMIT)
// against a plain single query, and fails if the p95 overhead exceeds the 15 ms budget in the plan.
// Run: pnpm --filter @orderloop/api bench:tenant   (needs `pnpm services:up` and `pnpm db:migrate:deploy`)
import { loadDotEnv, loadServerEnv } from '@orderloop/contracts/server';
import { Database } from '@orderloop/db';

loadDotEnv();
const env = loadServerEnv();
const db = new Database(env.DATABASE_URL, { max: 10 });
const tenantId = '0197b0a0-0000-7000-8000-000000000001';
const userId = '0197b0a0-0000-7000-8000-000000000002';
const WARMUP = 50;
const RUNS = 500;
const BUDGET_MS = 15;

const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;

async function time(
  fn: () => Promise<unknown>,
): Promise<{ p50: number; p95: number; p99: number }> {
  for (let i = 0; i < WARMUP; i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return { p50: pct(samples, 0.5), p95: pct(samples, 0.95), p99: pct(samples, 0.99) };
}

// Same indexed lookup in both cases; only the transaction + context wrapper differs.
const plain = await time(() => db.global.user.findFirst({ where: { id: userId } }));
const scoped = await time(() =>
  db.withContext({ tenantId, userId }, (tx) => tx.user.findFirst({ where: { id: userId } })),
);
// A realistic request does 2-3 queries, which share ONE transaction (and so one context round trip).
const scopedThree = await time(() =>
  db.withContext({ tenantId, userId }, async (tx) => {
    await tx.user.findFirst({ where: { id: userId } });
    await tx.membership.findFirst({ where: { userId } });
    await tx.session.findFirst({ where: { userId } });
  }),
);
const plainThree = await time(async () => {
  await db.global.user.findFirst({ where: { id: userId } });
  await db.global.session.findFirst({ where: { userId } });
  await db.global.refreshToken.findFirst({ where: { sessionId: userId } });
});

const f = (n: number) => n.toFixed(2).padStart(7);
console.log(`runs=${RUNS} (after ${WARMUP} warmup)           p50(ms)  p95(ms)  p99(ms)`);
console.log(`1 query, plain              ${f(plain.p50)}  ${f(plain.p95)}  ${f(plain.p99)}`);
console.log(`1 query, tenant transaction ${f(scoped.p50)}  ${f(scoped.p95)}  ${f(scoped.p99)}`);
console.log(
  `3 queries, plain            ${f(plainThree.p50)}  ${f(plainThree.p95)}  ${f(plainThree.p99)}`,
);
console.log(
  `3 queries, one tenant tx    ${f(scopedThree.p50)}  ${f(scopedThree.p95)}  ${f(scopedThree.p99)}`,
);
const overhead1 = scoped.p95 - plain.p95;
const overhead3 = scopedThree.p95 - plainThree.p95;
console.log(
  `p95 overhead: ${overhead1.toFixed(2)} ms (1 query), ${overhead3.toFixed(2)} ms (3 queries); budget ${BUDGET_MS} ms`,
);
await db.disconnect();
if (Math.max(overhead1, overhead3) > BUDGET_MS) {
  console.error('FAIL: tenant transaction overhead exceeds budget');
  process.exit(1);
}
console.log('PASS');
