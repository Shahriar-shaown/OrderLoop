import { z } from 'zod';
import { Problem } from './errors.js';
import { routes, type RouteSpec } from './routes.js';

/** Build an OpenAPI 3.1 document from the route registry. Pure; no I/O. */
export function buildOpenApiDocument(info: { title: string; version: string }) {
  const paths: Record<string, Record<string, unknown>> = {};
  const problem = z.toJSONSchema(Problem, { io: 'output' });

  for (const spec of Object.values(routes) as RouteSpec[]) {
    const openApiPath = spec.path.replace(/:(\w+)/g, '{$1}');
    const parameters: unknown[] = [];
    for (const [where, schema] of [
      ['path', spec.params],
      ['query', spec.query],
    ] as const) {
      if (!schema) continue;
      const json = z.toJSONSchema(schema, { io: 'input' }) as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      for (const [name, prop] of Object.entries(json.properties ?? {})) {
        parameters.push({
          name,
          in: where,
          required: where === 'path' || (json.required ?? []).includes(name),
          schema: prop,
        });
      }
    }
    const status = String(spec.status ?? 200);
    const operation: Record<string, unknown> = {
      operationId: spec.id,
      summary: spec.summary,
      ...(parameters.length ? { parameters } : {}),
      ...(spec.body
        ? {
            requestBody: {
              required: true,
              content: {
                'application/json': { schema: z.toJSONSchema(spec.body, { io: 'input' }) },
              },
            },
          }
        : {}),
      responses: {
        [status]: {
          description: 'Success',
          content: {
            'application/json': { schema: z.toJSONSchema(spec.response, { io: 'output' }) },
          },
        },
        default: {
          description: 'Error (RFC 9457 problem details)',
          content: { 'application/problem+json': { schema: problem } },
        },
      },
      ...(spec.auth === 'access' ? { security: [{ bearerAuth: [] }] } : {}),
      ...(spec.permission ? { 'x-required-permission': spec.permission } : {}),
    };
    (paths[openApiPath] ??= {})[spec.method.toLowerCase()] = operation;
  }

  return {
    openapi: '3.1.0',
    info,
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    },
  };
}
