import { Controller, Req } from '@nestjs/common';
import {
  routes,
  type CourierCheck,
  type CourierEntry,
  type LocationItem,
  type ParsedInput,
  type Shipment,
  type ShipmentDetail,
  type ShipmentRowPage,
  type ShipmentSummary,
  type ShippingQuote,
} from '@orderloop/contracts';
import { Auth, Endpoint, Input, type AppRequest, type AuthContext } from '../common/endpoint.js';
import { CouriersService } from './couriers.service.js';
import { ShipmentReportsService } from './shipment-reports.service.js';
import { ShipmentsService } from './shipments.service.js';

@Controller()
export class CouriersController {
  constructor(
    private readonly couriers: CouriersService,
    private readonly shipments: ShipmentsService,
    private readonly reports: ShipmentReportsService,
  ) {}

  @Endpoint(routes.listCouriers)
  list(@Auth() auth: AuthContext): Promise<CourierEntry[]> {
    return this.couriers.list(auth);
  }

  @Endpoint(routes.saveCourier)
  save(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.saveCourier>,
    @Req() req: AppRequest,
  ): Promise<CourierEntry> {
    return this.couriers.save(auth, input.params.provider, input.body, req.ip ?? null);
  }

  @Endpoint(routes.removeCourier)
  remove(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.removeCourier>,
    @Req() req: AppRequest,
  ): Promise<CourierEntry> {
    return this.couriers.remove(auth, input.params.provider, req.ip ?? null);
  }

  @Endpoint(routes.testCourier)
  test(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.testCourier>,
    @Req() req: AppRequest,
  ): Promise<CourierCheck> {
    return this.couriers.test(auth, input.params.provider, req.ip ?? null);
  }

  @Endpoint(routes.listCourierLocations)
  locations(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.listCourierLocations>,
  ): Promise<LocationItem[]> {
    return this.couriers.locations(auth, input.params.provider, input.query);
  }

  @Endpoint(routes.quoteShipping)
  quote(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.quoteShipping>,
  ): Promise<ShippingQuote> {
    return this.couriers.quote(auth, input.params.id, input.body);
  }

  @Endpoint(routes.bookShipment)
  book(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.bookShipment>,
    @Req() req: AppRequest,
  ): Promise<ShipmentDetail> {
    return this.shipments.book(auth, input.params.id, input.body, req.ip ?? null);
  }

  @Endpoint(routes.listOrderShipments)
  forOrder(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.listOrderShipments>,
  ): Promise<Shipment[]> {
    return this.shipments.listForOrder(auth, input.params.id);
  }

  @Endpoint(routes.getShipment)
  get(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.getShipment>,
  ): Promise<ShipmentDetail> {
    return this.shipments.get(auth, input.params.id);
  }

  @Endpoint(routes.refreshShipment)
  refresh(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.refreshShipment>,
    @Req() req: AppRequest,
  ): Promise<ShipmentDetail> {
    return this.shipments.refresh(auth, input.params.id, req.ip ?? null);
  }

  @Endpoint(routes.cancelShipment)
  cancel(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.cancelShipment>,
    @Req() req: AppRequest,
  ): Promise<ShipmentDetail> {
    return this.shipments.cancel(auth, input.params.id, input.body.reason, req.ip ?? null);
  }

  @Endpoint(routes.resolveShipment)
  resolve(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.resolveShipment>,
    @Req() req: AppRequest,
  ): Promise<ShipmentDetail> {
    return this.shipments.resolve(auth, input.params.id, input.body, req.ip ?? null);
  }

  @Endpoint(routes.simulateShipmentEvent)
  simulate(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.simulateShipmentEvent>,
    @Req() req: AppRequest,
  ): Promise<ShipmentDetail> {
    return this.shipments.simulate(auth, input.params.id, input.body.event, req.ip ?? null);
  }

  @Endpoint(routes.listShipments)
  listAll(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.listShipments>,
  ): Promise<ShipmentRowPage> {
    return this.reports.list(auth, input.query);
  }

  @Endpoint(routes.getShipmentSummary)
  stats(@Auth() auth: AuthContext): Promise<ShipmentSummary> {
    return this.reports.summary(auth);
  }
}
