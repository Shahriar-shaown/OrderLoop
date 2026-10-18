import { Controller } from '@nestjs/common';
import {
  routes,
  type InventoryPage,
  type InventorySummary,
  type LowStockItem,
  type MovementPage,
  type ParsedInput,
  type Reservation,
  type ReservationPage,
  type StockChange,
} from '@orderloop/contracts';
import { Auth, Endpoint, Input, type AuthContext } from '../common/endpoint.js';
import { InventoryService } from './inventory.service.js';
import { ReservationsService } from './reservations.service.js';

@Controller()
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly reservations: ReservationsService,
  ) {}

  @Endpoint(routes.listInventory)
  list(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.listInventory>,
  ): Promise<InventoryPage> {
    return this.inventory.list(auth, input.query);
  }

  @Endpoint(routes.receiveStock)
  receive(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.receiveStock>,
  ): Promise<StockChange> {
    return this.inventory.receive(auth, input.body);
  }

  @Endpoint(routes.adjustStock)
  adjust(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.adjustStock>,
  ): Promise<StockChange> {
    return this.inventory.adjust(auth, input.body);
  }

  @Endpoint(routes.damageStock)
  damage(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.damageStock>,
  ): Promise<StockChange> {
    return this.inventory.damage(auth, input.body);
  }

  @Endpoint(routes.writeOffStock)
  writeOff(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.writeOffStock>,
  ): Promise<StockChange> {
    return this.inventory.writeOff(auth, input.body);
  }

  @Endpoint(routes.returnStock)
  returnStock(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.returnStock>,
  ): Promise<StockChange> {
    return this.inventory.returnStock(auth, input.body);
  }

  @Endpoint(routes.listMovements)
  movements(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.listMovements>,
  ): Promise<MovementPage> {
    return this.inventory.movements(auth, input.query);
  }

  @Endpoint(routes.getInventorySummary)
  summary(@Auth() auth: AuthContext): Promise<InventorySummary> {
    return this.inventory.summary(auth);
  }

  @Endpoint(routes.lowStock)
  lowStock(@Auth() auth: AuthContext): Promise<LowStockItem[]> {
    return this.inventory.lowStock(auth);
  }

  @Endpoint(routes.listReservations)
  listReservations(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.listReservations>,
  ): Promise<ReservationPage> {
    return this.reservations.list(auth, input.query);
  }

  @Endpoint(routes.createReservation)
  createReservation(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.createReservation>,
  ): Promise<Reservation> {
    return this.reservations.create(auth, input.body);
  }

  @Endpoint(routes.releaseReservation)
  releaseReservation(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.releaseReservation>,
  ): Promise<Reservation> {
    return this.reservations.release(auth, input.params.id);
  }

  @Endpoint(routes.fulfilReservation)
  fulfilReservation(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.fulfilReservation>,
  ): Promise<Reservation> {
    return this.reservations.fulfil(auth, input.params.id);
  }
}
