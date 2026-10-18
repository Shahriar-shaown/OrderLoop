import type {
  Order,
  OrderDetail,
  OrderHistoryEntry,
  OrderStatus,
  OrderSummary,
} from '@orderloop/contracts';
import { cashPosition, holdsStock, ORDER_TRANSITIONS } from '@orderloop/domain';

export interface OrderRow {
  id: string;
  orderNumber: number;
  status: OrderStatus;
  source: Order['source'];
  sourceReference: string | null;
  notes: string | null;
  shipName: string;
  shipPhone: string;
  shipLine1: string;
  shipArea: string;
  shipDistrict: string;
  shipDivision: string;
  shipPostalCode: string | null;
  subtotalMinor: number;
  discountMinor: number;
  deliveryChargeMinor: number;
  totalMinor: number;
  advancePaidMinor: number;
  codAmountMinor: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  customer: { id: string; name: string; phone: string };
  items: {
    id: string;
    variantId: string;
    sku: string;
    productName: string;
    variantName: string;
    quantity: number;
    unitPriceMinor: number;
    discountMinor: number;
    lineTotalMinor: number;
  }[];
}

export const toOrder = (o: OrderRow): Order => ({
  id: o.id,
  orderNumber: o.orderNumber,
  status: o.status,
  source: o.source,
  sourceReference: o.sourceReference,
  notes: o.notes,
  customer: { id: o.customer.id, name: o.customer.name, phone: o.customer.phone },
  shipping: {
    recipientName: o.shipName,
    phone: o.shipPhone,
    line1: o.shipLine1,
    area: o.shipArea,
    district: o.shipDistrict,
    division: o.shipDivision,
    postalCode: o.shipPostalCode,
  },
  items: o.items.map((i) => ({
    id: i.id,
    variantId: i.variantId,
    sku: i.sku,
    productName: i.productName,
    variantName: i.variantName,
    quantity: i.quantity,
    unitPriceMinor: i.unitPriceMinor,
    discountMinor: i.discountMinor,
    lineTotalMinor: i.lineTotalMinor,
  })),
  subtotalMinor: o.subtotalMinor,
  discountMinor: o.discountMinor,
  deliveryChargeMinor: o.deliveryChargeMinor,
  totalMinor: o.totalMinor,
  advancePaidMinor: o.advancePaidMinor,
  codAmountMinor: o.codAmountMinor,
  stockHeld: holdsStock(o.status),
  version: o.version,
  createdAt: o.createdAt.toISOString(),
  updatedAt: o.updatedAt.toISOString(),
});

export const toDetail = (o: OrderRow, history: OrderHistoryEntry[]): OrderDetail => ({
  ...toOrder(o),
  history,
  allowedStatuses: [...ORDER_TRANSITIONS[o.status]],
});

export interface SummaryRow {
  id: string;
  order_number: number;
  status: OrderStatus;
  source: OrderSummary['source'];
  customer_id: string;
  customer_name: string;
  phone: string;
  district: string;
  item_count: bigint | number;
  total_minor: number;
  cod_amount_minor: number;
  created_at: Date;
  first_item: string | null;
  first_qty: number | null;
  line_count: bigint | number;
  courier_provider: 'mock' | 'pathao' | 'steadfast' | null;
  courier_status: string | null;
  courier_simulated: boolean | null;
  collected: bigint | number;
  sv: Date | number | string;
}

/**
 * The order's cash in a seller's words. Delivered is never "collected": only cash a courier statement reports is. An order
 * with nothing to collect is prepaid; a cancelled or returned one owes nothing; a delivered one with no real courier
 * shipment cannot be confirmed by any statement.
 */
export function paymentState(r: {
  status: OrderStatus;
  cod: number;
  collected: number;
  realCourier: boolean;
}): OrderSummary['payment'] {
  if (r.cod === 0) return 'prepaid';
  if (r.status === 'cancelled' || r.status === 'returned' || r.status === 'return_requested')
    return 'not_due';
  if (r.status !== 'delivered') return 'cod_pending';
  if (!r.realCourier) return 'cod_untracked';
  const pos = cashPosition({
    status: r.status,
    codAmountMinor: r.cod,
    collectedMinor: r.collected,
  });
  return pos.state === 'unpaid'
    ? 'cod_unpaid'
    : pos.state === 'partial'
      ? 'cod_partial'
      : 'cod_collected';
}

export const toSummary = (r: SummaryRow): OrderSummary => ({
  id: r.id,
  orderNumber: r.order_number,
  status: r.status,
  source: r.source,
  customerId: r.customer_id,
  customerName: r.customer_name,
  phone: r.phone,
  district: r.district,
  itemCount: Number(r.item_count),
  totalMinor: r.total_minor,
  codAmountMinor: r.cod_amount_minor,
  createdAt: r.created_at.toISOString(),
  itemsSummary: r.first_item
    ? `${r.first_item} ×${r.first_qty ?? 1}${Number(r.line_count) > 1 ? ` +${Number(r.line_count) - 1}` : ''}`
    : '',
  payment: paymentState({
    status: r.status,
    cod: r.cod_amount_minor,
    collected: Number(r.collected),
    realCourier: !!r.courier_provider && r.courier_simulated === false,
  }),
  courier: r.courier_provider
    ? {
        provider: r.courier_provider,
        simulated: !!r.courier_simulated,
        status: r.courier_status as never,
      }
    : null,
});
