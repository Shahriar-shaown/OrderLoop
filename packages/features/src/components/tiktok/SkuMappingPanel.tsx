import type { TikTokSkuLink } from '@orderloop/contracts';
import { Badge, Card, EmptyState, LoadMore, Row, Stack, Tabs, Text } from '@orderloop/ui';
import { useState } from 'react';
import { useCan } from '../../core/permissions';
import { useSkuLinks } from '../../lib/tiktok';
import { QueryBoundary } from '../../shell/QueryBoundary';
import { MockBadge } from './Badges';
import { MapSkuControl } from './MapSkuControl';
import { VariantText } from './VariantText';

function SkuRow({ link, canEdit, mock }: { link: TikTokSkuLink; canEdit: boolean; mock: boolean }) {
  const label = link.sellerSku ?? link.externalSkuId;
  return (
    <Card variant="outlined" padding="md" role="group" aria-label={`TikTok SKU ${label}`}>
      <Stack gap={2}>
        <Row gap={3} wrap justify="between" align="start">
          <Stack gap={1} grow style={{ minWidth: 200 }}>
            <Text weight="medium" verbatim>
              {link.productName ?? 'Unnamed TikTok product'}
            </Text>
            <Text variant="caption" tone="muted" verbatim>
              {link.sellerSku
                ? `Seller SKU ${link.sellerSku} · TikTok SKU ${link.externalSkuId}`
                : `No seller SKU · TikTok SKU ${link.externalSkuId}`}
            </Text>
            <Row gap={2} wrap>
              <Text variant="caption" tone="muted" verbatim>
                {link.shopName}
              </Text>
              {mock && <MockBadge />}
            </Row>
          </Stack>
          {link.waitingOrders > 0 && (
            <Badge tone="warning" dot>
              {`${link.waitingOrders} waiting ${link.waitingOrders === 1 ? 'order' : 'orders'}`}
            </Badge>
          )}
        </Row>
        {link.variant ? (
          <Row gap={2} wrap>
            <Text>Linked to</Text>
            <VariantText variant={link.variant} />
            <Badge>{link.source === 'auto' ? 'Matched by SKU' : 'Chosen by a person'}</Badge>
          </Row>
        ) : (
          <Text tone="muted">
            Not mapped: orders with this SKU wait, and no stock moves for them.
          </Text>
        )}
        {canEdit ? (
          <MapSkuControl linkId={link.id} skuLabel={label} mapped={!!link.variant} />
        ) : (
          <Text variant="small" tone="muted">
            Your role can look at SKU links but not change them.
          </Text>
        )}
      </Stack>
    </Card>
  );
}

/**
 * Which of your products each TikTok SKU is. The SKUs waiting for a link come first: an order with one of them waits and moves
 * no stock until a person maps it. Saving a link looks at the waiting orders again at once.
 */
export function SkuMappingPanel({ mock }: { mock: boolean }) {
  const can = useCan();
  const [view, setView] = useState<'waiting' | 'all'>('waiting');
  const query = useSkuLinks(view === 'waiting');
  const pages = query.data?.pages ?? [];
  const rows = pages.flatMap((p) => p.items);
  const waiting = pages[0]?.unmappedCount;
  return (
    <Stack gap={4}>
      <Text tone="muted">
        TikTok calls each product variant a SKU. OrderLoop links a TikTok SKU to your product when
        the seller SKU equals your SKU; any other has to be mapped here by a person.
      </Text>
      <Tabs
        variant="chips"
        label="SKU view"
        items={[
          { value: 'waiting', label: 'Waiting for a link', count: waiting },
          { value: 'all', label: 'All SKUs' },
        ]}
        value={view}
        onChange={(v) => setView(v as 'waiting' | 'all')}
      />
      <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading SKUs">
        {rows.length === 0 ? (
          <EmptyState icon="layers" title={view === 'waiting' ? 'Nothing to map' : 'No SKUs yet'}>
            {view === 'waiting'
              ? 'Every TikTok SKU seen so far is linked to a product.'
              : 'A SKU appears here the first time it is on a TikTok order.'}
          </EmptyState>
        ) : (
          <Stack gap={3}>
            {rows.map((link) => (
              <SkuRow key={link.id} link={link} canEdit={can('inventory:write')} mock={mock} />
            ))}
            <LoadMore
              hasNext={!!query.hasNextPage}
              loading={query.isFetchingNextPage}
              onPress={() => void query.fetchNextPage()}
            />
          </Stack>
        )}
      </QueryBoundary>
    </Stack>
  );
}
