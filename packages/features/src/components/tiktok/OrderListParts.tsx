import type { TikTokOrderSummary } from '@orderloop/contracts';
import { Badge, Link, Row, Stack, Text, type Column } from '@orderloop/ui';
import { formatWhen } from '../../lib/format';
import { ATTENTION_TEXT, stockState } from '../../lib/tiktok';
import { MockBadge, ShopMoney, StockBadge, TikTokStatusBadge } from './Badges';

/** "2 items": the units on the order (the same wording as the social drafts). */
export const itemsText = (n: number) => `${n} item${n === 1 ? '' : 's'}`;

/** The marker for an order that needs a person: it was cancelled after its stock shipped. */
export function AttentionMarker({ order }: { order: TikTokOrderSummary }) {
  if (!order.attention) return null;
  return (
    <Row gap={1} wrap>
      <Badge tone="error" dot>
        Needs a look
      </Badge>
      <Text variant="caption" tone="danger">
        {ATTENTION_TEXT}
      </Text>
    </Row>
  );
}

/** The stock badge with a short sentence under it saying what it means. */
function StockCell({ order }: { order: TikTokOrderSummary }) {
  return (
    <Stack gap={1}>
      <StockBadge state={order.stockState} />
      <Text variant="caption" tone="muted">
        {stockState(order.stockState).hint}
      </Text>
      <AttentionMarker order={order} />
    </Stack>
  );
}

function OrderId({ order }: { order: TikTokOrderSummary }) {
  return (
    <Stack gap={1}>
      <Link href={`/tiktok-orders/${order.id}`} weight="medium">
        {order.externalOrderId}
      </Link>
      <Row gap={2} wrap>
        <Text variant="caption" tone="muted" verbatim>
          {order.shopName}
        </Text>
        {order.mock && <MockBadge />}
      </Row>
    </Stack>
  );
}

export const orderColumns: Column<TikTokOrderSummary>[] = [
  {
    key: 'order',
    header: 'TikTok order',
    flex: 2,
    minWidth: 170,
    render: (o) => <OrderId order={o} />,
  },
  {
    key: 'status',
    header: 'Status',
    flex: 1.4,
    minWidth: 140,
    render: (o) => <TikTokStatusBadge status={o.status} onHold={o.onHold} />,
  },
  { key: 'stock', header: 'Stock', flex: 3, minWidth: 220, render: (o) => <StockCell order={o} /> },
  {
    key: 'total',
    header: 'Total (shop currency)',
    flex: 1.4,
    minWidth: 150,
    align: 'right',
    render: (o) => <ShopMoney minor={o.totalMinor} order={o} />,
  },
  {
    key: 'items',
    header: 'Items',
    minWidth: 90,
    show: 'wide',
    render: (o) => itemsText(o.unitCount),
  },
  {
    key: 'updated',
    header: 'Last updated',
    flex: 1.5,
    minWidth: 150,
    show: 'wide',
    render: (o) => (o.statusUpdatedAt ? formatWhen(o.statusUpdatedAt) : '—'),
  },
];

/** A TikTok order as a card on a phone. */
export function OrderCard({ order }: { order: TikTokOrderSummary }) {
  return (
    <Stack gap={2}>
      <Row justify="between" gap={2} wrap>
        <OrderId order={order} />
        <TikTokStatusBadge status={order.status} onHold={order.onHold} />
      </Row>
      <StockCell order={order} />
      <Row justify="between" gap={2} wrap>
        <ShopMoney minor={order.totalMinor} order={order} weight="medium" />
        <Text variant="caption" tone="muted">
          {itemsText(order.unitCount)}
        </Text>
      </Row>
      {order.statusUpdatedAt && (
        <Text variant="caption" tone="muted">
          {formatWhen(order.statusUpdatedAt)}
        </Text>
      )}
    </Stack>
  );
}
