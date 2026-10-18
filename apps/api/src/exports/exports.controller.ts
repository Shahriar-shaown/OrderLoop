import { Controller, Req } from '@nestjs/common';
import { routes, type CsvExport } from '@orderloop/contracts';
import { Auth, Endpoint, type AppRequest, type AuthContext } from '../common/endpoint.js';
import { ExportsService } from './exports.service.js';

@Controller()
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Endpoint(routes.exportProducts)
  products(@Auth() auth: AuthContext, @Req() req: AppRequest): Promise<CsvExport> {
    return this.exports.products(auth, req.ip ?? null);
  }

  @Endpoint(routes.exportStock)
  stock(@Auth() auth: AuthContext, @Req() req: AppRequest): Promise<CsvExport> {
    return this.exports.stock(auth, req.ip ?? null);
  }
}
