import { Controller, Req } from '@nestjs/common';
import {
  routes,
  type OrderImportPreview,
  type OrderImportResult,
  type ParsedInput,
} from '@orderloop/contracts';
import { Auth, Endpoint, Input, type AppRequest, type AuthContext } from '../common/endpoint.js';
import { OrderImportService } from './order-import.service.js';

@Controller()
export class OrderImportController {
  constructor(private readonly imports: OrderImportService) {}

  @Endpoint(routes.validateOrderImport)
  validate(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.validateOrderImport>,
  ): Promise<OrderImportPreview> {
    return this.imports.validate(auth, input.body);
  }

  @Endpoint(routes.importOrders)
  apply(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.importOrders>,
    @Req() req: AppRequest,
  ): Promise<OrderImportResult> {
    return this.imports.apply(auth, input.body, req.ip ?? null);
  }
}
