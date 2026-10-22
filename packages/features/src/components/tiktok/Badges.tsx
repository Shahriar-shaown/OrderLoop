import type { TikTokOrderSummary } from '@orderloop/contracts';
import { Badge, Row, Text, useLocale, type TextProps } from '@orderloop/ui';
import { formatShopMoney } from '../../lib/shopMoney';
import { orderStatus, stockState } from '../../lib/tiktok';

/** An amount in the shop's own currency ("MYR 12.50"). Never taka, so it never goes through the taka formatter. */
export function ShopMoney({
  minor,
  order,
  ...text
}: { minor: number; order: Pick<TikTokOrderSummary, 'currency' | 'currencyExponent'> } & Omit<
  TextProps,
  'children' | 'verbatim' | 'numeric'
>) {
  const { locale } = useLocale();
  return (
    <Text numeric verbatim {...text}>
      {formatShopMoney(minor, order.currency, order.currencyExponent, locale)}
    </Text>
  );
}

/** TikTok's status for an order: any value is shown, a new one as it came. */
export function TikTokStatusBadge({ status, onHold }: { status: string; onHold?: boolean }) {
  const s = orderStatus(status);
  return (
    <Row gap={1} wrap>
      <Badge tone={s.tone} dot>
        {s.label}
      </Badge>
      {onHold && status !== 'ON_HOLD' && <Badge>Buyer can still cancel</Badge>}
    </Row>
  );
}

/** What the stock did for an order. */
export function StockBadge({ state }: { state: string }) {
  const s = stockState(state);
  return (
    <Badge tone={s.tone} dot>
      {s.label}
    </Badge>
  );
}

/** "Mock" next to anything simulated. */
export function MockBadge() {
  return <Badge tone="warning">Mock</Badge>;
}
