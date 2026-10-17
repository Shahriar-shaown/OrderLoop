import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, type NextFunction, type Request, type Response } from 'express';
import { bodyParserProblem } from './common/body-parser-problem.js';

/**
 * Settings shared by main.ts and the test harness. Create the app with `{ bodyParser: false }`; the parsers are set up here.
 *
 * JSON bodies are capped at 100 KB everywhere. The one exception is the catalog import, which carries a CSV of up to 2 MB
 * (3 MB allows for JSON escaping), and even there only callers that present a bearer token get the large allowance: the
 * body is parsed before authentication runs, so without this check anyone could make the server buffer 3 MB per request.
 */
export function configureApp(app: NestExpressApplication): void {
  app.use(
    '/v1/imports/products',
    (req: Request, res: Response, next: NextFunction) => {
      if (!req.headers.authorization?.startsWith('Bearer ')) {
        res.status(401).type('application/problem+json').json({
          type: 'urn:orderloop:error:unauthorized',
          title: 'unauthorized',
          status: 401,
          code: 'unauthorized',
          detail: 'Authentication required',
        });
        return;
      }
      next();
    },
    json({ limit: '3mb' }),
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
