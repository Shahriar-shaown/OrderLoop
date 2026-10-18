import type {
  Order,
  OrderDetail,
  OrderHistoryEntry,
  OrderStatus,
  OrderSummary,
} from '@orderloop/contracts';
import { holdsStock, ORDER_TRANSITIONS } from '@orderloop/domain';

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
  sv: Date | number | string;
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
});
