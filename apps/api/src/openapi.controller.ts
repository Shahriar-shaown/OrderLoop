import { Controller } from '@nestjs/common';
import { buildOpenApiDocument, routes } from '@orderloop/contracts';
import { Endpoint } from './common/endpoint.js';

/** Machine-readable API description, generated from the same route registry the controllers use. */
@Controller()
export class OpenApiController {
  private readonly document = buildOpenApiDocument({ title: 'OrderLoop API', version: '0.0.0' });

  @Endpoint(routes.openapi)
  openapi() {
    return this.document;
  }
}
