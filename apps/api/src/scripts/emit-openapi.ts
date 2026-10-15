// Writes the OpenAPI document generated from the route registry. Run: pnpm --filter @orderloop/api openapi
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildOpenApiDocument } from '@orderloop/contracts';

const target = resolve(process.cwd(), '../../docs/openapi.json');
writeFileSync(
  target,
  `${JSON.stringify(buildOpenApiDocument({ title: 'OrderLoop API', version: '0.0.0' }), null, 2)}\n`,
);
console.log(`wrote ${target}`);
