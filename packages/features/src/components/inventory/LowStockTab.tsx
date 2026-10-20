import type { LowStockItem } from '@orderloop/contracts';
import { Button, DataTable, EmptyState, Row, Stack, Text, type Column } from '@orderloop/ui';
import { useQuery } from '@tanstack/react-query';
import { variantLabel } from '../../lib/format';
import { useCan } from '../../core/permissions';
import { useApi } from '../../core/runtime';
import { QueryBoundary } from '../../shell/QueryBoundary';
import type { VariantRef } from './StockDialog';
import { stockStatus, StockStatusBadge } from './StockStatusBadge';

const refOf = (r: LowStockItem): VariantRef => ({
  id: r.variantId,
  sku: r.sku,
  label: variantLabel(r.productName, r.variantName),
  onHand: r.onHand,
  available: r.available,
});

/** Variants at or below their reorder point, with a way to receive more. */
export function LowStockTab({ onReceive }: { onReceive: (variant: VariantRef) => void }) {
  const api = useApi();
  const can = useCan();
  const query = useQuery({ queryKey: ['lowStock'], queryFn: () => api.inventory.lowStock() });
  const receive = (r: LowStockItem) =>
    can('inventory:write') ? (
      <Button size="sm" variant="secondary" icon="box" onPress={() => onReceive(refOf(r))}>
        Receive stock
      </Button>
    ) : null;
  const columns: Column<LowStockItem>[] = [
    {
      key: 'item',
      header: 'Item',
      flex: 3,
      minWidth: 220,
      render: (r) => (
        <Stack gap={1}>
          <Text weight="medium">{variantLabel(r.productName, r.variantName)}</Text>
          <Text variant="caption" tone="muted">
            {r.sku}
          </Text>
        </Stack>
      ),
    },
    {
      key: 'available',
      header: 'Available',
      align: 'right',
      minWidth: 100,
      render: (r) => <Text numeric>{String(r.available)}</Text>,
    },
    {
      key: 'reorder',
      header: 'Reorder at',
      align: 'right',
      minWidth: 100,
      show: 'wide',
      render: (r) => <Text numeric>{String(r.reorderPoint)}</Text>,
    },
    {
      key: 'status',
      header: 'Status',
      flex: 2,
      minWidth: 150,
      render: (r) => <StockStatusBadge status={stockStatus(r.available, r.reorderPoint)} />,
    },
    { key: 'actions', header: 'Actions', align: 'right', minWidth: 150, render: receive },
  ];
  const rows = query.data ?? [];
  return (
    <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading low stock">
      {rows.length === 0 ? (
        <EmptyState icon="check-circle" title="Nothing is running low">
          Variants appear here when available stock falls to their reorder point.
        </EmptyState>
      ) : (
        <DataTable
          label="Low stock"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.variantId}
          renderCard={(r) => (
            <Stack gap={2}>
              <Row justify="between" gap={2} align="start">
                <Stack gap={1} style={{ flexShrink: 1 }}>
                  <Text weight="medium">{variantLabel(r.productName, r.variantName)}</Text>
                  <Text variant="caption" tone="muted">
                    {`${r.sku} · reorder at ${r.reorderPoint}`}
                  </Text>
                </Stack>
                <StockStatusBadge status={stockStatus(r.available, r.reorderPoint)} />
              </Row>
              {receive(r)}
            </Stack>
          )}
        />
      )}
    </QueryBoundary>
  );
}
