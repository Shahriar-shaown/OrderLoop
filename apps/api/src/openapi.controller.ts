import { Controller, Inject } from '@nestjs/common';
import { buildOpenApiDocument, routes } from '@orderloop/contracts';
import { ApiError } from './common/api-error.js';
import { Endpoint } from './common/endpoint.js';
import { APP_CONFIG, type AppConfig } from './config/config.module.js';

/** Machine-readable API description, generated from the same route registry the controllers use. */
@Controller()
export class OpenApiController {
  private readonly document = buildOpenApiDocument({ title: 'OrderLoop API', version: '0.0.0' });

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Endpoint(routes.openapi)
  openapi() {
    // OPENAPI_PUBLIC=false hides the route map from anonymous callers (it holds no secrets; see docs/api.md).
    if (!this.config.OPENAPI_PUBLIC) throw ApiError.notFound();
    return this.document;
  }
}
