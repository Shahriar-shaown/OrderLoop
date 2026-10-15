import { readFileSync } from 'node:fs';
import { buildOpenApiDocument } from '@orderloop/contracts';
import { describe, expect, it } from 'vitest';

describe('docs/openapi.json', () => {
  it('is up to date with the route registry (run `pnpm --filter @orderloop/api openapi` after changing routes)', () => {
    const committed = JSON.parse(
      readFileSync(new URL('../../../docs/openapi.json', import.meta.url), 'utf8'),
    );
    expect(committed).toEqual(buildOpenApiDocument({ title: 'OrderLoop API', version: '0.0.0' }));
  });
});
