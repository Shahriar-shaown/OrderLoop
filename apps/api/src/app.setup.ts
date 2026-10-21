import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, raw, urlencoded, type NextFunction, type Request, type Response } from 'express';
import { bodyParserProblem } from './common/body-parser-problem.js';

/**
 * Refuses a request that carries no bearer token. A browser's CORS preflight (OPTIONS) never carries one, by design, and
 * must reach the CORS handler: answering it with 401 here would stop every browser from ever calling the route.
 */
export function requireBearerToken(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'OPTIONS' || req.headers.authorization?.startsWith('Bearer ')) {
    next();
    return;
  }
  res.status(401).type('application/problem+json').json({
    type: 'urn:orderloop:error:unauthorized',
    title: 'unauthorized',
    status: 401,
    code: 'unauthorized',
    detail: 'Authentication required',
  });
}

/**
 * Settings shared by main.ts and the test harness. Create the app with `{ bodyParser: false }`; the parsers are set up here.
 *
 * JSON bodies are capped at 100 KB everywhere. The exceptions are the CSV uploads (catalog and order imports: up to 2 MB;
 * settlement statements: up to 2.5 MB, the schema's limit; 3 MB allows for JSON escaping), and even there only callers that present a bearer token get the large allowance: the
 * body is parsed before authentication runs, so without this check anyone could make the server buffer 3 MB per request.
 */
export function configureApp(app: NestExpressApplication): void {
  app.use(
    ['/v1/imports/products', '/v1/imports/orders', '/v1/settlements/import'],
    requireBearerToken,
    json({ limit: '3mb' }),
  );
  // Meta signs the exact bytes it sends, so the webhook body is kept raw (a Buffer) and parsed only after the signature is
  // checked. Its two callbacks arrive form-encoded (signed_request=...). Both are small.
  app.use((req: Request, res: Response, next: NextFunction) =>
    req.method === 'POST' && req.path === '/v1/webhooks/meta'
      ? raw({ type: () => true, limit: '512kb' })(req, res, next)
      : next(),
  );
  app.use(
    ['/v1/webhooks/meta/deauthorize', '/v1/webhooks/meta/data-deletion'],
    urlencoded({ extended: false, limit: '20kb' }),
  );
  app.use(json({ limit: '100kb' })); // skipped for requests the route above already parsed
  // Parser failures (too large, invalid JSON) happen before any controller or guard. Answer them here as problem details;
  // otherwise they reach the generic handler, which can echo the parser's message (it may quote the body).
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const problem = bodyParserProblem(err);
    if (!problem) return next(err);
    res.status(problem.status).type('application/problem+json').json(problem);
  });
}
