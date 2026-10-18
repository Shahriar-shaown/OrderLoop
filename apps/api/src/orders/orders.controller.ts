import { Controller, Req } from '@nestjs/common';
import {
  routes,
  type BulkResult,
  type OrderDetail,
  type OrderPage,
  type ParsedInput,
  type PotentialDuplicate,
} from '@orderloop/contracts';
import { Auth, Endpoint, Input, type AppRequest, type AuthContext } from '../common/endpoint.js';
import { OrdersService } from './orders.service.js';

@Controller()
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Endpoint(routes.listOrders)
  list(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.listOrders>,
  ): Promise<OrderPage> {
    return this.orders.list(auth, input.query);
  }

  @Endpoint(routes.createOrder)
  create(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.createOrder>,
    @Req() req: AppRequest,
  ): Promise<OrderDetail> {
    return this.orders.create(auth, input.body, req.ip ?? null);
  }

  @Endpoint(routes.checkOrderDuplicates)
  check(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.checkOrderDuplicates>,
  ): Promise<PotentialDuplicate[]> {
    return this.orders.checkDuplicates(auth, input.body);
  }

  @Endpoint(routes.bulkChangeOrderStatus)
  bulk(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.bulkChangeOrderStatus>,
    @Req() req: AppRequest,
  ): Promise<BulkResult> {
    return this.orders.bulkChangeStatus(auth, input.body, req.ip ?? null);
  }

  @Endpoint(routes.getOrder)
  get(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.getOrder>,
  ): Promise<OrderDetail> {
    return this.orders.get(auth, input.params.id);
  }

  @Endpoint(routes.updateOrder)
  update(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.updateOrder>,
    @Req() req: AppRequest,
  ): Promise<OrderDetail> {
    return this.orders.update(auth, input.params.id, input.body, req.ip ?? null);
  }

  @Endpoint(routes.changeOrderStatus)
  changeStatus(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.changeOrderStatus>,
    @Req() req: AppRequest,
  ): Promise<OrderDetail> {
    return this.orders.changeStatus(auth, input.params.id, input.body, req.ip ?? null);
  }

  @Endpoint(routes.listOrderDuplicates)
  duplicates(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.listOrderDuplicates>,
  ): Promise<PotentialDuplicate[]> {
    return this.orders.duplicatesOf(auth, input.params.id);
  }
}
