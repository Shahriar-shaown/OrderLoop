import { randomUUID } from 'node:crypto';
import {
  ConsoleMessagingProvider,
  DevPushProvider,
  processDelivery,
  type DeliverDeps,
  type DeliverOutcome,
  type EmailMessage,
  type EmailSender,
  type MessagingMessage,
} from '@orderloop/automation';
import { AutomationRuntime } from '../src/automation/automation.runtime.js';
import { bearer, createProduct, type TestApp } from './app.js';

export interface FakeJob {
  id: string;
  name: string;
  data: Record<string, unknown>;
  opts: Record<string, unknown>;
  attemptsStarted: number;
  done: boolean;
}

/**
 * A queue that behaves like BullMQ where it matters: adding a job under an id that is already there is ignored (so
 * deterministic ids de-duplicate), and `fail` simulates Redis being down.
 */
export function fakeQueue() {
  const jobs = new Map<string, FakeJob>();
  const q = {
    jobs,
    fail: false,
    adds: 0,
    async add(name: string, data: object, opts: { jobId?: string } & Record<string, unknown> = {}) {
      q.adds += 1;
      if (q.fail) throw new Error('redis down');
      const id = opts.jobId ?? randomUUID();
      if (jobs.has(id)) return null;
      jobs.set(id, {
        id,
        name,
        data: data as Record<string, unknown>,
        opts,
        attemptsStarted: 0,
        done: false,
      });
      return { id };
    },
    list: (name?: string) => [...jobs.values()].filter((j) => !name || j.name === name),
    pending: () => [...jobs.values()].filter((j) => !j.done),
  };
  return q;
}
export type FakeQueue = ReturnType<typeof fakeQueue>;

/** Run every job that is not done yet, the way a worker would (one attempt each); returns what each did. */
export async function drain<T>(
  queue: FakeQueue,
  run: (job: FakeJob) => Promise<T>,
): Promise<{ job: FakeJob; result?: T; error?: unknown }[]> {
  const out: { job: FakeJob; result?: T; error?: unknown }[] = [];
  for (const job of queue.pending()) {
    job.attemptsStarted += 1;
    try {
      out.push({ job, result: await run(job) });
      job.done = true;
    } catch (error) {
      out.push({ job, error });
    }
  }
  return out;
}

/** What the fake providers received, so a test can count sends. */
export interface Sent {
  push: { device: string; title: string; body: string; data: { kind: string; id: string } }[];
  email: EmailMessage[];
  sms: MessagingMessage[];
  whatsapp: MessagingMessage[];
}

export function deliveryHarness(t: TestApp, opts: { now?: () => Date } = {}) {
  const sent: Sent = { push: [], email: [], sms: [], whatsapp: [] };
  const control: {
    emailError: unknown;
    emailErrorTimes: number;
    pushProvider: { send: DevPushProvider['send'] } | null;
  } = { emailError: null, emailErrorTimes: 0, pushProvider: null };
  const email: EmailSender = {
    async send(m) {
      if (control.emailError && control.emailErrorTimes > 0) {
        control.emailErrorTimes -= 1;
        throw control.emailError;
      }
      sent.email.push(m);
      await t.mail.send({
        kind: 'notification',
        to: m.to,
        subject: m.subject,
        text: m.text,
        html: m.html,
      });
    },
  };
  const dev = new DevPushProvider({
    log: () => undefined,
    outboxPath: 'memory',
    append: async (_p, line) => {
      sent.push.push(JSON.parse(line));
    },
  });
  const deps: DeliverDeps = {
    db: t.db,
    now: opts.now ?? (() => new Date()),
    log: () => undefined,
    providers: {
      push: {
        dev: {
          name: 'dev',
          send: (m) => (control.pushProvider ?? dev).send(m),
        },
      },
      email,
      sms: new ConsoleMessagingProvider({ log: () => undefined, sink: (m) => sent.sms.push(m) }),
      whatsapp: new ConsoleMessagingProvider({
        log: () => undefined,
        sink: (m) => sent.whatsapp.push(m),
      }),
    },
  };
  const process = (job: FakeJob): Promise<DeliverOutcome> =>
    processDelivery(deps, job.data as { tenantId: string; deliveryId: string }, {
      jobId: job.id,
      attempt: job.attemptsStarted,
      maxAttempts: 5,
    });
  return { sent, control, deps, process };
}

export const runtimeOf = (t: TestApp) => t.app.get(AutomationRuntime);

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A product with one variant, a reorder point and `stock` units on the shelf. */
export async function lowStockItem(
  t: TestApp,
  token: string,
  opts: { stock: number; reorderPoint?: number; name?: string },
) {
  const { variant, product } = await createProduct(t, token, {
    reorderPoint: opts.reorderPoint ?? 5,
    ...(opts.name ? { name: opts.name } : {}),
  });
  if (opts.stock > 0)
    await t.http
      .post('/v1/inventory/receive')
      .set(bearer(token))
      .send({ variantId: variant.id, quantity: opts.stock })
      .expect(201);
  return { variantId: variant.id, productId: product.id, sku: variant.sku };
}

let phoneSeq = 5000;
/** An order for a fresh customer, created through the API. */
export async function placeOrder(
  t: TestApp,
  token: string,
  variantId: string,
  extra: object & { customerName?: string; confirm?: boolean } = {},
) {
  const { customerName, ...rest } = extra as { customerName?: string };
  const phone = `0171${String(1000000 + ++phoneSeq).slice(-7)}`;
  const res = await t.http
    .post('/v1/orders')
    .set(bearer(token))
    .send({
      customer: { name: customerName ?? 'Rina Akter', phone },
      address: {
        recipientName: customerName ?? 'Rina Akter',
        phone,
        line1: 'House 5, Road 3, Dhanmondi',
        area: 'Dhanmondi',
        district: 'Dhaka',
        division: 'Dhaka',
      },
      items: [{ variantId, quantity: 1 }],
      idempotencyKey: `ord-${randomUUID()}`,
      ...rest,
    });
  if (res.status !== 201) throw new Error(`order failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; orderNumber: number };
}
