import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { processImportJob } from '@orderloop/catalog';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createTestApp, registerTenant, type TestApp } from './app.js';
import { testEnv } from './test-env.js';

const WORKER = resolve(import.meta.dirname, '../../worker/dist/main.js');

let t: TestApp;
let worker: ChildProcess;
let workerOutput = '';
let owner: Awaited<ReturnType<typeof registerTenant>>;

/** Start the real worker (a separate process, built from apps/worker) and wait until it is listening. */
async function startWorker(): Promise<ChildProcess> {
  const child = spawn('node', [WORKER], {
    cwd: mkdtempSync(join(tmpdir(), 'orderloop-worker-')),
    env: { PATH: process.env.PATH ?? '', ...testEnv },
  });
  child.stdout.on('data', (d) => (workerOutput += String(d)));
  child.stderr.on('data', (d) => (workerOutput += String(d)));
  const deadline = Date.now() + 20_000;
  while (!workerOutput.includes('listening on queue "imports"')) {
    if (child.exitCode !== null) throw new Error(`worker exited early:\n${workerOutput}`);
    if (Date.now() > deadline) throw new Error(`worker did not start:\n${workerOutput}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return child;
}

beforeAll(async () => {
  t = await createTestApp();
  owner = await registerTenant(t);
  worker = await startWorker();
}, 60_000);

afterAll(async () => {
  worker?.kill('SIGTERM');
  await new Promise((r) => (worker?.exitCode === null ? worker.once('exit', r) : r(null)));
  await t.close();
});

const auth = () => bearer(owner.accessToken);
const submit = (csv: string, token = owner.accessToken) =>
  t.http.post('/v1/imports/products').set(bearer(token)).send({ csv });

type Job = {
  id: string;
  status: string;
  totalRows: number | null;
  created: number;
  updated: number;
  failed: number;
  errors: { row: number; message: string }[];
  startedAt: string | null;
  finishedAt: string | null;
};
async function finished(id: string, token = owner.accessToken): Promise<Job> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const job = (await t.http.get(`/v1/imports/${id}`).set(bearer(token))).body as Job;
    if (job.status === 'COMPLETED' || job.status === 'FAILED') return job;
    if (Date.now() > deadline)
      throw new Error(
        `import ${id} still ${job.status} after 30s\nworker output:\n${workerOutput}`,
      );
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Stock lines for one SKU: find the variant first, so the answer does not depend on how many other lines exist. */
async function stockOf(
  sku: string,
): Promise<{ sku: string; locationName: string; onHand: number }[]> {
  const found = (await t.http.get(`/v1/products?q=${encodeURIComponent(sku)}`).set(auth())).body
    .items as { variants: { id: string; sku: string }[] }[];
  const variant = found.flatMap((p) => p.variants).find((v) => v.sku === sku.toUpperCase());
  if (!variant) return [];
  return (await t.http.get(`/v1/inventory?variantId=${variant.id}`).set(auth())).body.items;
}

const HEADER =
  'product_name,sku,price,category,unit,variant_name,cost,reorder_point,opening_stock,location';
const stamp = Date.now();
const CSV = [
  HEADER,
  `Cotton T-Shirt,TEE-${stamp}-RM,1250.50,Shirts,pcs,Red / M,800,5,20,`,
  `Cotton T-Shirt,TEE-${stamp}-RL,1250.50,Shirts,pcs,Red / L,800,5,10,Dhaka outlet`,
  `Basmati Rice,RICE-${stamp},650,Grocery,kg,5 kg bag,,,40,`,
].join('\n');

describe('importing a catalog through the API, the queue and the worker', () => {
  it('accepts the file at once (202) and the worker creates products, variants, categories, locations and opening stock', async () => {
    const res = await submit(CSV);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'PENDING', created: 0, failed: 0 });

    const job = await finished(res.body.id);
    expect(job).toMatchObject({
      status: 'COMPLETED',
      totalRows: 3,
      created: 3,
      updated: 0,
      failed: 0,
      errors: [],
    });
    expect(job.startedAt).toEqual(expect.any(String));
    expect(job.finishedAt).toEqual(expect.any(String));

    const products = (await t.http.get(`/v1/products?q=${stamp}`).set(auth())).body.items;
    expect(products).toHaveLength(2);
    const tee = products.find((p: { name: string }) => p.name === 'Cotton T-Shirt');
    expect(tee.variants.map((v: { sku: string }) => v.sku).sort()).toEqual([
      `TEE-${stamp}-RL`,
      `TEE-${stamp}-RM`,
    ]);
    expect(tee.variants.find((v: { sku: string }) => v.sku.endsWith('-RM'))).toMatchObject({
      priceMinor: 125_050,
      costMinor: 80_000,
      reorderPoint: 5,
      name: 'Red / M',
      stock: { onHand: 20 },
    });
    expect(products.find((p: { name: string }) => p.name === 'Basmati Rice')).toMatchObject({
      unit: 'kg',
    });

    const cats = (await t.http.get('/v1/categories').set(auth())).body.map(
      (c: { name: string }) => c.name,
    );
    expect(cats).toEqual(expect.arrayContaining(['Shirts', 'Grocery']));
    const locations = (await t.http.get('/v1/locations').set(auth())).body.map(
      (l: { name: string }) => l.name,
    );
    expect(locations).toEqual(expect.arrayContaining(['Main warehouse', 'Dhaka outlet']));

    const lines = [
      ...(await stockOf(`TEE-${stamp}-RM`)),
      ...(await stockOf(`TEE-${stamp}-RL`)),
      ...(await stockOf(`RICE-${stamp}`)),
    ];
    expect(lines.map((l) => `${l.sku}|${l.locationName}|${l.onHand}`).sort()).toEqual(
      [
        `TEE-${stamp}-RM|Main warehouse|20`,
        `TEE-${stamp}-RL|Dhaka outlet|10`,
        `RICE-${stamp}|Main warehouse|40`,
      ].sort(),
    );
    const movements = (
      await t.http.get('/v1/inventory/movements?limit=100').set(auth())
    ).body.items.filter((m: { reason: string }) => m.reason === 'Opening stock (import)');
    expect(movements).toHaveLength(3);
    expect(
      movements.every(
        (m: { referenceType: string; referenceId: string }) =>
          m.referenceType === 'import' && m.referenceId === job.id,
      ),
    ).toBe(true);
  });

  it('deletes the raw CSV from the database once processed, and keeps no copy in the queue payload', async () => {
    const res = await submit(`${HEADER}\nRetention Mug,RET-${stamp},100,,,,,,,`);
    const job = await finished(res.body.id);
    expect(job.status).toBe('COMPLETED');
    const row = await t.db.withContext({ tenantId: owner.tenant.id }, (tx) =>
      tx.importJob.findUniqueOrThrow({ where: { id: res.body.id } }),
    );
    expect(row.csv).toBeNull();
  });

  it('re-importing the same file updates prices but never double-counts opening stock', async () => {
    const skus = [`TEE-${stamp}-RM`, `TEE-${stamp}-RL`, `RICE-${stamp}`];
    const snapshot = async () =>
      (await Promise.all(skus.map(stockOf)))
        .flat()
        .map((l) => `${l.sku}|${l.locationName}|${l.onHand}`)
        .sort();
    const before = await snapshot();
    expect(before).toHaveLength(3); // the first test's stock is really there to compare against
    const repriced = CSV.replaceAll('1250.50', '1300');
    const job = await finished((await submit(repriced)).body.id);
    expect(job).toMatchObject({ status: 'COMPLETED', created: 0, updated: 3, failed: 0 });
    const after = await snapshot();
    expect(after).toEqual(before);
    const tee = (await t.http.get(`/v1/products?q=TEE-${stamp}`).set(auth())).body.items[0];
    expect(tee.variants.every((v: { priceMinor: number }) => v.priceMinor === 130_000)).toBe(true);
  });

  it('records row problems for the user to fix, and still imports the good rows', async () => {
    const existingSku = `CLASH-${stamp}`;
    await finished(
      (await submit(`${HEADER}\nFirst Owner Of Sku,${existingSku},100,,pcs,,,,,`)).body.id,
    );
    const csv = [
      HEADER,
      `Good Row,GOOD-${stamp},10,,pcs,,,,5,`,
      `,NO-NAME-${stamp},10,,,,,,,`,
      `Bad Price,BADP-${stamp},12.345,,,,,,,`,
      `Bad Sku,bad sku!,10,,,,,,,`,
      `Steals A Sku,${existingSku},10,,pcs,,,,,`,
      `First Owner Of Sku,UNIT-${stamp},10,,kg,,,,,`,
    ].join('\n');
    const job = await finished((await submit(csv)).body.id);
    expect(job).toMatchObject({
      status: 'COMPLETED',
      totalRows: 6,
      created: 1,
      updated: 0,
      failed: 5,
    });
    const byRow = Object.fromEntries(job.errors.map((e) => [e.row, e.message]));
    expect(byRow[3]).toMatch(/product_name is required/);
    expect(byRow[4]).toMatch(/price must be/);
    expect(byRow[5]).toMatch(/sku is invalid/);
    expect(byRow[6]).toMatch(/already belongs to a different product/);
    expect(byRow[7]).toMatch(/already exists with unit pcs/);
    expect((await t.http.get(`/v1/products?q=GOOD-${stamp}`).set(auth())).body.items).toHaveLength(
      1,
    );
    expect((await t.http.get(`/v1/products?q=BADP-${stamp}`).set(auth())).body.items).toHaveLength(
      0,
    );
  });

  it('fails a malformed file as a whole, with a clear reason, and imports nothing', async () => {
    const cases: [string, RegExp][] = [
      ['product_name,sku\nA,B', /Missing required.*price/],
      [`${HEADER},surprise\nA,B,1,,,,,,,,`, /Unknown column.*surprise/],
      [`${HEADER}\n"unterminated,S1,1`, /Unterminated/],
      [`${HEADER}`, /no rows/],
    ];
    for (const [csv, reason] of cases) {
      const job = await finished((await submit(csv)).body.id);
      expect(job.status, csv).toBe('FAILED');
      expect(job.errors[0]!.message).toMatch(reason);
      expect(job.created + job.updated).toBe(0);
    }
  });

  it('only people who may change the catalog can import, and imports are private to their tenant', async () => {
    const staff = await addMember(t, owner, 'STAFF');
    expect((await submit(`${HEADER}\nX,X-1,1,,,,,,,`, staff.accessToken)).status).toBe(403);
    expect((await t.http.get('/v1/imports').set(bearer(staff.accessToken))).status).toBe(403);
    expect((await t.http.post('/v1/imports/products').send({ csv: 'a' })).status).toBe(401);

    const mine = (await submit(`${HEADER}\nPrivate Item,PRIV-${stamp},1,,,,,,,`)).body;
    const other = await registerTenant(t);
    expect((await t.http.get(`/v1/imports/${mine.id}`).set(bearer(other.accessToken))).status).toBe(
      404,
    );
    expect((await t.http.get('/v1/imports').set(bearer(other.accessToken))).body).toHaveLength(0);
    await finished(mine.id);
    // The other tenant can import the same SKU independently.
    const theirs = await finished(
      (await submit(`${HEADER}\nPrivate Item,PRIV-${stamp},1,,,,,,,`, other.accessToken)).body.id,
      other.accessToken,
    );
    expect(theirs).toMatchObject({ status: 'COMPLETED', created: 1 });
  });

  it('lists recent imports newest first and validates the request body', async () => {
    const list = (await t.http.get('/v1/imports').set(auth())).body as Job[];
    expect(list.length).toBeGreaterThan(3);
    expect(list.length).toBeLessThanOrEqual(20);
    expect((await t.http.post('/v1/imports/products').set(auth()).send({})).status).toBe(400);
    expect((await t.http.post('/v1/imports/products').set(auth()).send({ csv: '' })).status).toBe(
      400,
    );
    expect((await t.http.get('/v1/imports/not-a-uuid').set(auth())).status).toBe(400);
  });

  it('accepts a realistically large file (about 1 MB) that the default body limit would have rejected', async () => {
    const rows = Array.from(
      { length: 4000 },
      (_, i) => `Bulk Item ${i},BULK-${stamp}-${i},${10 + (i % 90)}.50,Bulk,pcs,,,,${i % 7},`,
    );
    const csv = [HEADER, ...rows].join('\n');
    expect(csv.length).toBeGreaterThan(200_000);
    const res = await submit(csv);
    expect(res.status).toBe(202);
    const job = await finished(res.body.id);
    expect(job).toMatchObject({ status: 'COMPLETED', totalRows: 4000, created: 4000, failed: 0 });
  }, 120_000);
});

describe('the processor itself', () => {
  const insertJob = (csv: string, extra: object = {}) =>
    t.db.withContext({ tenantId: owner.tenant.id }, (tx) =>
      tx.importJob.create({
        data: {
          tenantId: owner.tenant.id,
          kind: 'products',
          csv,
          createdById: owner.user.id,
          ...extra,
        },
      }),
    );

  it('two workers handed the same job process it exactly once', async () => {
    const job = await insertJob(`${HEADER}\nContended,CONT-${stamp},10,,pcs,,,,9,`);
    await Promise.all(
      [1, 2, 3, 4].map(() =>
        processImportJob(t.db, { tenantId: owner.tenant.id, importId: job.id }),
      ),
    );
    const done = (await t.http.get(`/v1/imports/${job.id}`).set(auth())).body as Job;
    expect(done).toMatchObject({ status: 'COMPLETED', created: 1 });
    const stock = await stockOf(`CONT-${stamp}`);
    expect(stock).toHaveLength(1);
    expect(stock[0]!.onHand).toBe(9); // not 36: four workers, one claim
  });

  it('a finished job cannot be processed again', async () => {
    const job = await insertJob(`${HEADER}\nOnce,ONCE-${stamp},10,,pcs,,,,5,`);
    await processImportJob(t.db, { tenantId: owner.tenant.id, importId: job.id });
    await processImportJob(t.db, { tenantId: owner.tenant.id, importId: job.id });
    const stock = await stockOf(`ONCE-${stamp}`);
    expect(stock).toHaveLength(1);
    expect(stock[0]!.onHand).toBe(5);
  });

  it('a job abandoned by a crashed worker is resumed, but a recently started one is left alone', async () => {
    const stale = await insertJob(`${HEADER}\nStale,STALE-${stamp},10,,pcs,,,,3,`, {
      status: 'RUNNING',
      startedAt: new Date(Date.now() - 20 * 60_000),
    });
    const fresh = await insertJob(`${HEADER}\nFresh,FRESH-${stamp},10,,pcs,,,,3,`, {
      status: 'RUNNING',
      startedAt: new Date(),
    });
    await processImportJob(t.db, { tenantId: owner.tenant.id, importId: stale.id });
    await processImportJob(t.db, { tenantId: owner.tenant.id, importId: fresh.id });
    expect(((await t.http.get(`/v1/imports/${stale.id}`).set(auth())).body as Job).status).toBe(
      'COMPLETED',
    );
    expect(((await t.http.get(`/v1/imports/${fresh.id}`).set(auth())).body as Job).status).toBe(
      'RUNNING',
    );
  });

  it("cannot be pointed at another tenant's job", async () => {
    const other = await registerTenant(t);
    const job = await t.db.withContext({ tenantId: other.tenant.id }, (tx) =>
      tx.importJob.create({
        data: {
          tenantId: other.tenant.id,
          kind: 'products',
          csv: `${HEADER}\nX,XT-${stamp},1,,,,,,,`,
        },
      }),
    );
    await processImportJob(t.db, { tenantId: owner.tenant.id, importId: job.id }); // wrong tenant context: the job is invisible
    const row = await t.db.withContext({ tenantId: other.tenant.id }, (tx) =>
      tx.importJob.findUniqueOrThrow({ where: { id: job.id } }),
    );
    expect(row.status).toBe('PENDING');
  });
});

describe('queueing', () => {
  it('puts only ids on the queue, never the CSV', async () => {
    const calls: unknown[][] = [];
    const spy = await createTestApp(
      {},
      {
        queue: {
          add: async (...args: unknown[]) => void calls.push(args),
          close: async () => undefined,
        },
      },
    );
    try {
      const own = await registerTenant(spy);
      const res = await spy.http
        .post('/v1/imports/products')
        .set(bearer(own.accessToken))
        .send({ csv: `${HEADER}\nSecret Price List,SPL-1,999,,,,,,,` });
      expect(res.status).toBe(202);
      expect(calls).toHaveLength(1);
      const [name, data, opts] = calls[0] as [
        string,
        Record<string, string>,
        Record<string, unknown>,
      ];
      expect(name).toBe('products');
      expect(data).toEqual({ tenantId: own.tenant.id, importId: res.body.id });
      expect(JSON.stringify(calls)).not.toContain('Secret Price List');
      expect(opts.jobId).toBe(res.body.id);
    } finally {
      await spy.close();
    }
  });

  it('if the queue is down, the user is told, the job is marked failed, and the CSV is not left behind', async () => {
    const down = await createTestApp(
      {},
      {
        queue: {
          add: async () => {
            throw new Error('ECONNREFUSED');
          },
          close: async () => undefined,
        },
      },
    );
    try {
      const own = await registerTenant(down);
      const res = await down.http
        .post('/v1/imports/products')
        .set(bearer(own.accessToken))
        .send({ csv: `${HEADER}\nX,Q-1,1,,,,,,,` });
      expect(res.status).toBe(503);
      const jobs = (await down.http.get('/v1/imports').set(bearer(own.accessToken))).body as Job[];
      expect(jobs[0]).toMatchObject({ status: 'FAILED' });
      expect(jobs[0]!.errors[0]!.message).toMatch(/could not be queued/);
      const row = await down.db.withContext({ tenantId: own.tenant.id }, (tx) =>
        tx.importJob.findFirstOrThrow({ where: { tenantId: own.tenant.id } }),
      );
      expect(row.csv).toBeNull();
    } finally {
      await down.close();
    }
  });
});
