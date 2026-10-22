import { describe, expect, it } from 'vitest';
import { logUnhandled } from './unhandled.js';

describe('logUnhandled', () => {
  it('writes one JSON line with the stable event, the worker service and no secrets', () => {
    const lines: string[] = [];
    logUnhandled('uncaughtException', new Error('failed password=hunter2hunter2'), (l) =>
      lines.push(l),
    );
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: 'unhandled_error',
      service: 'orderloop-worker',
      source: 'uncaughtException',
      level: 'error',
    });
    expect(lines[0]).not.toContain('hunter2hunter2');
  });
});
