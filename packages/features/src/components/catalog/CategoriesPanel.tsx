import type { Category } from '@orderloop/contracts';
import {
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  Menu,
  Row,
  Stack,
  Text,
  useToast,
  type Column,
} from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { messageFor } from '../../forms/errors';
import { useCategories } from '../../lib/hooks';
import { useCan } from '../../core/permissions';
import { useApi } from '../../core/runtime';
import { NameDialog } from '../../forms/NameDialog';
import { QueryBoundary } from '../../shell/QueryBoundary';

/** List, add, rename and delete categories, in place. */
export function CategoriesPanel() {
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useCategories();
  const [editing, setEditing] = useState<{ category: Category | null } | null>(null);
  const [deleting, setDeleting] = useState<Category | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['categories'] });
  const writable = can('catalog:write');

  async function remove(category: Category) {
    setBusy(true);
    try {
      await api.categories.remove(category.id);
      await Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: ['products'] })]);
      toast.success(`Deleted ${category.name}`);
      setDeleting(null);
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(false);
    }
  }

  const actions = (c: Category) =>
    writable ? (
      <Menu
        label={`Actions for ${c.name}`}
        items={[
          {
            key: 'rename',
            label: 'Rename',
            icon: 'edit',
            onPress: () => setEditing({ category: c }),
          },
          {
            key: 'delete',
            label: 'Delete',
            icon: 'trash',
            danger: true,
            onPress: () => setDeleting(c),
          },
        ]}
      />
    ) : null;

  const columns: Column<Category>[] = [
    {
      key: 'name',
      header: 'Name',
      flex: 4,
      minWidth: 200,
      render: (c) => <Text weight="medium">{c.name}</Text>,
    },
    ...(writable
      ? [
          {
            key: 'actions',
            header: 'Actions',
            align: 'right' as const,
            minWidth: 80,
            render: actions,
          },
        ]
      : []),
  ];
  const rows = query.data ?? [];

  return (
    <Stack gap={4}>
      <Row justify="between" align="center" gap={3} wrap>
        <Text tone="muted" style={{ flexShrink: 1, maxWidth: 560 }}>
          Group products so they are easy to find. Deleting a category keeps its products; they just
          have no category.
        </Text>
        {writable && (
          <Button icon="plus" onPress={() => setEditing({ category: null })}>
            New category
          </Button>
        )}
      </Row>
      <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading categories">
        {rows.length === 0 ? (
          <EmptyState icon="tag" title="No categories yet">
            {writable
              ? 'Create one to start grouping products.'
              : 'Ask someone with catalog access to create categories.'}
          </EmptyState>
        ) : (
          <DataTable
            label="Categories"
            columns={columns}
            rows={rows}
            rowKey={(c) => c.id}
            renderCard={(c) => (
              <Row justify="between" align="center" gap={2}>
                <Text weight="medium">{c.name}</Text>
                {actions(c)}
              </Row>
            )}
          />
        )}
      </QueryBoundary>
      <NameDialog
        open={editing !== null}
        title={editing?.category ? 'Rename category' : 'New category'}
        label="Category name"
        initial={editing?.category?.name ?? ''}
        submitLabel={editing?.category ? 'Save' : 'Create category'}
        success={editing?.category ? 'Category renamed' : 'Category created'}
        icon="tag"
        onSubmit={async (name) => {
          if (editing?.category) await api.categories.rename(editing.category.id, name);
          else await api.categories.create(name);
          await refresh();
        }}
        onClose={() => setEditing(null)}
      />
      <ConfirmDialog
        open={deleting !== null}
        title="Delete this category?"
        confirmLabel="Delete"
        danger
        busy={busy}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove(deleting)}
      >
        {`"${deleting?.name ?? ''}" is removed. Its products are kept and become uncategorised.`}
      </ConfirmDialog>
    </Stack>
  );
}
