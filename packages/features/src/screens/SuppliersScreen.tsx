import type { Supplier } from '@orderloop/contracts';
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  PageHeader,
  Row,
  Stack,
  Text,
  useToast,
  type Column,
} from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { QueryBoundary } from '../components/QueryBoundary';
import { SupplierDialog } from '../components/SupplierDialog';
import { messageFor } from '../errors';
import { useSuppliers } from '../hooks';
import { useCan } from '../permissions';
import { useApi } from '../runtime';

/** Who you buy from. Products can name a supplier; archiving one hides it from the pickers without losing history. */
export function SuppliersScreen() {
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useSuppliers();
  const [editing, setEditing] = useState<{ supplier: Supplier | null } | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const writable = can('catalog:write');

  async function toggleArchived(s: Supplier) {
    setWorking(s.id);
    try {
      await api.suppliers.update(s.id, { archived: !s.archived });
      await queryClient.invalidateQueries({ queryKey: ['suppliers'] });
      toast.success(s.archived ? 'Supplier restored' : 'Supplier archived');
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setWorking(null);
    }
  }

  const columns: Column<Supplier>[] = [
    {
      key: 'name',
      header: 'Supplier',
      flex: 3,
      minWidth: 200,
      render: (s) => (
        <Stack gap={1}>
          <Row gap={2} wrap>
            <Text weight="medium">{s.name}</Text>
            {s.archived ? <Badge>Archived</Badge> : null}
          </Row>
          {s.contactName ? (
            <Text variant="caption" tone="muted">
              {s.contactName}
            </Text>
          ) : null}
        </Stack>
      ),
    },
    { key: 'phone', header: 'Phone', flex: 2, minWidth: 140, render: (s) => s.phone ?? '—' },
    { key: 'email', header: 'Email', flex: 2, minWidth: 180, render: (s) => s.email ?? '—' },
    ...(writable
      ? [
          {
            key: 'actions',
            header: 'Actions',
            flex: 2,
            minWidth: 200,
            render: (s: Supplier) => (
              <Row gap={1} wrap>
                <Button size="sm" variant="secondary" onPress={() => setEditing({ supplier: s })}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={working === s.id}
                  onPress={() => toggleArchived(s)}
                >
                  {s.archived ? 'Restore' : 'Archive'}
                </Button>
              </Row>
            ),
          },
        ]
      : []),
  ];

  return (
    <Stack gap={5}>
      <PageHeader
        title="Suppliers"
        description="The people and companies you buy stock from."
        actions={
          writable ? (
            <Button onPress={() => setEditing({ supplier: null })}>New supplier</Button>
          ) : undefined
        }
      />
      <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading suppliers">
        {(query.data ?? []).length === 0 ? (
          <EmptyState title="No suppliers yet">
            Add the businesses you buy from, then pick one on each product.
          </EmptyState>
        ) : (
          <DataTable
            label="Suppliers"
            columns={columns}
            rows={query.data ?? []}
            rowKey={(s) => s.id}
          />
        )}
      </QueryBoundary>
      <SupplierDialog
        supplier={editing?.supplier ?? null}
        open={editing !== null}
        onClose={() => setEditing(null)}
      />
    </Stack>
  );
}
