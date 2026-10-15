import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from './openapi.js';
import { routes } from './routes.js';

describe('route registry', () => {
  it('has unique operation ids and unique method+path pairs', () => {
    const specs = Object.values(routes);
    expect(new Set(specs.map((s) => s.id)).size).toBe(specs.length);
    expect(new Set(specs.map((s) => `${s.method} ${s.path}`)).size).toBe(specs.length);
  });

  it('keys match operation ids', () => {
    for (const [key, spec] of Object.entries(routes)) expect(spec.id).toBe(key);
  });

  it('every access route that is not self-service declares a permission or is intentionally open to any member', () => {
    const openToAnyMember = new Set(['logout', 'switchTenant', 'me']);
    for (const spec of Object.values(routes)) {
      if (spec.auth === 'access' && !openToAnyMember.has(spec.id))
        expect('permission' in spec).toBe(true);
    }
  });
});

describe('openapi', () => {
  const doc = buildOpenApiDocument({ title: 'OrderLoop API', version: '0.0.0' });
  it('documents every route', () => {
    const ops = Object.values(doc.paths).flatMap(
      (p) => Object.values(p) as { operationId: string }[],
    );
    expect(ops.map((o) => o.operationId).sort()).toEqual(Object.keys(routes).sort());
  });
  it('converts path params and marks them required', () => {
    const op = doc.paths['/v1/members/{id}']!['patch'] as {
      parameters: { name: string; in: string; required: boolean }[];
    };
    expect(op.parameters).toContainEqual(
      expect.objectContaining({ name: 'id', in: 'path', required: true }),
    );
  });
});
