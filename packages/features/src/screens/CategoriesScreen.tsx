import type { Category } from '@orderloop/contracts';
import {
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  PageHeader,
  Row,
  Stack,
  useToast,
  type Column,
} from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { NameDialog } from '../components/NameDialog';
import { QueryBoundary } from '../components/QueryBoundary';
import { messageFor } from '../errors';
import { useCategories } from '../hooks';
import { useCan } from '../permissions';
import { useApi } from '../runtime';

export function CategoriesScreen() {
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

  const columns: Column<Category>[] = [
    { key: 'name', header: 'Name', flex: 3, minWidth: 200, render: (c) => c.name },
    ...(writable
      ? [
          {
            key: 'actions',
            header: 'Actions',
            minWidth: 200,
            render: (c: Category) => (
              <Row gap={1}>
                <Button size="sm" variant="secondary" onPress={() => setEditing({ category: c })}>
                  Rename
                </Button>
                <Button size="sm" variant="ghost" onPress={() => setDeleting(c)}>
                  Delete
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
        title="Categories"
        description="Group products so they are easy to find. Deleting a category keeps its products; they just have no category."
        actions={
          writable ? (
            <Button onPress={() => setEditing({ category: null })}>New category</Button>
          ) : undefined
        }
      />
      <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading categories">
        {(query.data ?? []).length === 0 ? (
          <EmptyState title="No categories yet">
            {writable
              ? 'Create one to start grouping products.'
              : 'Ask someone with catalog access to create categories.'}
          </EmptyState>
        ) : (
          <DataTable
            label="Categories"
            columns={columns}
            rows={query.data ?? []}
            rowKey={(c) => c.id}
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
