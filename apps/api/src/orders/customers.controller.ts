import { Controller, Req } from '@nestjs/common';
import {
  routes,
  type AddressRecord,
  type CustomerDetail,
  type CustomerPage,
  type OrderPage,
  type ParsedInput,
} from '@orderloop/contracts';
import { Auth, Endpoint, Input, type AppRequest, type AuthContext } from '../common/endpoint.js';
import { CustomersService } from './customers.service.js';
import { OrdersService } from './orders.service.js';

@Controller()
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly orders: OrdersService,
  ) {}

  @Endpoint(routes.listCustomers)
  list(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.listCustomers>,
  ): Promise<CustomerPage> {
    return this.customers.list(auth, input.query);
  }

  @Endpoint(routes.createCustomer)
  create(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.createCustomer>,
    @Req() req: AppRequest,
  ): Promise<CustomerDetail> {
    return this.customers.create(auth, input.body, req.ip ?? null);
  }

  @Endpoint(routes.getCustomer)
  get(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.getCustomer>,
  ): Promise<CustomerDetail> {
    return this.customers.get(auth, input.params.id);
  }

  @Endpoint(routes.updateCustomer)
  update(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.updateCustomer>,
    @Req() req: AppRequest,
  ): Promise<CustomerDetail> {
    return this.customers.update(auth, input.params.id, input.body, req.ip ?? null);
  }

  @Endpoint(routes.addCustomerAddress)
  addAddress(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.addCustomerAddress>,
    @Req() req: AppRequest,
  ): Promise<AddressRecord> {
    return this.customers.addAddress(auth, input.params.id, input.body, req.ip ?? null);
  }

  @Endpoint(routes.updateCustomerAddress)
  updateAddress(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.updateCustomerAddress>,
    @Req() req: AppRequest,
  ): Promise<AddressRecord> {
    return this.customers.updateAddress(
      auth,
      input.params.id,
      input.params.addressId,
      input.body,
      req.ip ?? null,
    );
  }

  @Endpoint(routes.deleteCustomerAddress)
  async deleteAddress(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.deleteCustomerAddress>,
    @Req() req: AppRequest,
  ): Promise<Record<string, never>> {
    await this.customers.deleteAddress(
      auth,
      input.params.id,
      input.params.addressId,
      req.ip ?? null,
    );
    return {};
  }

  @Endpoint(routes.listCustomerOrders)
  async orderHistory(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.listCustomerOrders>,
  ): Promise<OrderPage> {
    // 404 for another business's customer (or a missing one), not an empty history that would hint it exists.
    await this.customers.get(auth, input.params.id);
    return this.orders.list(
      auth,
      {
        sort: 'createdAt',
        dir: 'desc',
        limit: input.query.limit,
        ...(input.query.cursor ? { cursor: input.query.cursor } : {}),
      },
      input.params.id,
    );
  }
}
