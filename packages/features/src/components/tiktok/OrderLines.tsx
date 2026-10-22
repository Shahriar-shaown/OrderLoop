import type { TikTokOrder, TikTokOrderLine } from '@orderloop/contracts';
import { Badge, Card, Row, Stack, Text } from '@orderloop/ui';
import { useCan } from '../../core/permissions';
import { holdLabel } from '../../lib/tiktok';
import { ShopMoney } from './Badges';
import { MapSkuControl } from './MapSkuControl';
import { VariantText } from './VariantText';

const HOLD_TONE = { held: 'info', shipped: 'success', released: 'neutral' } as const;

/** One line of a TikTok order: what was sold, the product it is linked to (or "Not mapped" with the way to map it), and its stock. */
function Line({ line, order }: { line: TikTokOrderLine; order: TikTokOrder }) {
  const can = useCan();
  const label = line.sellerSku ?? line.externalSkuId;
  const blocking = !line.mapped && line.hold === null;
  return (
    <Card variant="outlined" padding="md" role="group" aria-label={`Order line ${label}`}>
      <Stack gap={2}>
        <Row gap={3} wrap justify="between" align="start">
          <Stack gap={1} grow style={{ minWidth: 200 }}>
            <Text weight="medium" verbatim>
              {line.productName ?? 'Unnamed TikTok product'}
            </Text>
            <Text variant="caption" tone="muted" verbatim>
              {line.sellerSku
                ? `Seller SKU ${line.sellerSku} · TikTok SKU ${line.externalSkuId}`
                : `No seller SKU · TikTok SKU ${line.externalSkuId}`}
            </Text>
          </Stack>
          <Stack gap={1} align="end">
            <Row gap={1} wrap>
              <Text numeric>{`${line.quantity} ×`}</Text>
              <ShopMoney minor={line.unitPriceMinor} order={order} />
            </Row>
          </Stack>
        </Row>
        <Row gap={2} wrap>
          {line.variant ? (
            <>
              <Text>OrderLoop product</Text>
              <VariantText variant={line.variant} />
            </>
          ) : (
            <Badge tone="warning">Not mapped</Badge>
          )}
          <Badge tone={line.hold ? (HOLD_TONE[line.hold] ?? 'neutral') : 'neutral'} dot>
            {holdLabel(line.hold)}
          </Badge>
        </Row>
        {blocking &&
          line.skuLinkId &&
          (can('inventory:write') ? (
            <MapSkuControl linkId={line.skuLinkId} skuLabel={label} mapped={false} />
          ) : (
            <Text variant="small" tone="muted">
              This item is not linked to a product. Someone who can change inventory has to map it.
            </Text>
          ))}
      </Stack>
    </Card>
  );
}

export function OrderLines({ order }: { order: TikTokOrder }) {
  return (
    <Stack gap={3}>
      {order.lines.map((line) => (
        <Line key={line.key} line={line} order={order} />
      ))}
    </Stack>
  );
}
