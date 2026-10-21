import { describe, expect, it } from 'vitest';
import { enqueueSocialEvent, socialEventJobId } from './jobs.js';

const job = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  eventId: '22222222-2222-4222-8222-222222222222',
};

describe('social event queueing', () => {
  it('uses a deterministic id without a colon (BullMQ refuses it)', () => {
    expect(socialEventJobId(job.eventId)).toBe(`social-event__${job.eventId}`);
    expect(socialEventJobId(job.eventId)).not.toContain(':');
  });
  it('queues under that id with retries', async () => {
    const added: { name: string; opts: Record<string, unknown> }[] = [];
    const ok = await enqueueSocialEvent(
      { add: async (name, _d, opts) => void added.push({ name, opts: opts ?? {} }) },
      job,
    );
    expect(ok).toBe(true);
    expect(added[0]!.opts).toMatchObject({ jobId: socialEventJobId(job.eventId), attempts: 5 });
  });
  it('answers false (not an error) when the queue throws', async () => {
    expect(
      await enqueueSocialEvent({ add: async () => Promise.reject(new Error('redis down')) }, job),
    ).toBe(false);
  });
  it('does not wait for a queue that never answers (Redis down): well inside Meta’s five seconds', async () => {
    const started = Date.now();
    const ok = await enqueueSocialEvent({ add: () => new Promise(() => undefined) }, job, 100);
    expect(ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
