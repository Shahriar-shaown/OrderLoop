import { describe, expect, it } from 'vitest';
import { logUnhandled } from './unhandled.js';

describe('logUnhandled', () => {
  it('writes one JSON line with the stable event and no secrets', () => {
    const lines: string[] = [];
    logUnhandled(
      'unhandledRejection',
      new Error('connect failed postgresql://app_user:hunter2@db:5432/orderloop'),
      (l) => lines.push(l),
    );
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({
      event: 'unhandled_error',
      service: 'orderloop-api',
      source: 'unhandledRejection',
      level: 'error',
    });
    expect(lines[0]).not.toContain('hunter2');
  });
});
