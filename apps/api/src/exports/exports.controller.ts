import { Controller, Req } from '@nestjs/common';
import { routes, type CsvExport, type ParsedInput } from '@orderloop/contracts';
import { LoginThrottleService } from '../auth/login-throttle.service.js';
import { Auth, Endpoint, Input, type AppRequest, type AuthContext } from '../common/endpoint.js';
import { ExportsService } from './exports.service.js';

@Controller()
export class ExportsController {
  constructor(
    private readonly exports: ExportsService,
    private readonly throttle: LoginThrottleService,
  ) {}

  /** An export reads a whole table: a per-business budget, however many users or IPs it comes from. */
  private limit(auth: AuthContext, scope: string): Promise<void> {
    return this.throttle.enforce(scope, auth.tenantId, 5, 60);
  }

  @Endpoint(routes.exportProducts)
  async products(@Auth() auth: AuthContext, @Req() req: AppRequest): Promise<CsvExport> {
    await this.limit(auth, 'export-products');
    return this.exports.products(auth, req.ip ?? null);
  }

  @Endpoint(routes.exportStock)
  async stock(@Auth() auth: AuthContext, @Req() req: AppRequest): Promise<CsvExport> {
    await this.limit(auth, 'export-stock');
    return this.exports.stock(auth, req.ip ?? null);
  }

  @Endpoint(routes.exportCustomers)
  async customers(@Auth() auth: AuthContext, @Req() req: AppRequest): Promise<CsvExport> {
    await this.limit(auth, 'export-customers');
    return this.exports.customers(auth, req.ip ?? null);
  }

  @Endpoint(routes.exportOrders)
  async orders(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.exportOrders>,
    @Req() req: AppRequest,
  ): Promise<CsvExport> {
    await this.limit(auth, 'export-orders');
    return this.exports.orders(auth, input.query, req.ip ?? null);
  }
}
