import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { createRequire } from 'node:module';

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OrderLoop API</title>
    <link rel="stylesheet" href="/api-docs/assets/swagger-ui.css" />
  </head>
  <body>
    <div id="ui"></div>
    <script src="/api-docs/assets/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: '/openapi.json',
        dom_id: '#ui',
        deepLinking: true,
        persistAuthorization: true,
        tryItOutEnabled: true,
        docExpansion: 'list',
        tagsSorter: 'alpha',
      });
    </script>
  </body>
</html>`;

/**
 * An interactive API playground (Swagger UI) at /api-docs, reading the generated /openapi.json. To call protected routes,
 * try POST /v1/auth/login, copy the accessToken from the response, and paste it into "Authorize".
 * It is mounted before helmet so the page's own scripts are not blocked; it holds no secrets. Not served in production.
 */
export function mountApiDocs(app: NestExpressApplication): void {
  const require = createRequire(import.meta.url);
  const assets = (
    require('swagger-ui-dist') as { getAbsoluteFSPath(): string }
  ).getAbsoluteFSPath();
  const server = app.getHttpAdapter().getInstance() as express.Express;
  server.get('/api-docs', (_req, res) => {
    res.type('html').send(PAGE);
  });
  server.use('/api-docs/assets', express.static(assets, { index: false }));
}
