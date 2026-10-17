import type { Location } from '@orderloop/contracts';
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
import { NameDialog } from '../components/NameDialog';
import { QueryBoundary } from '../components/QueryBoundary';
import { messageFor } from '../errors';
import { useLocations } from '../hooks';
import { useCan } from '../permissions';
import { useApi } from '../runtime';

export function LocationsScreen() {
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useLocations();
  const [editing, setEditing] = useState<{ location: Location | null } | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['locations'] });
  const writable = can('catalog:write') || can('inventory:write');

  async function change(
    location: Location,
    body: Parameters<typeof api.locations.update>[1],
    message: string,
  ) {
    setWorking(location.id);
    try {
      await api.locations.update(location.id, body);
      await refresh();
      toast.success(message);
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setWorking(null);
    }
  }

  const columns: Column<Location>[] = [
    {
      key: 'name',
      header: 'Name',
      flex: 3,
      minWidth: 200,
      render: (l) => (
        <Row gap={2} wrap>
          <Text>{l.name}</Text>
          {l.isDefault ? <Badge tone="info">Default</Badge> : null}
          {l.archived ? <Badge>Archived</Badge> : null}
        </Row>
      ),
    },
    ...(writable
      ? [
          {
            key: 'actions',
            header: 'Actions',
            flex: 3,
            minWidth: 320,
            render: (l: Location) => (
              <Row gap={1} wrap>
                <Button size="sm" variant="secondary" onPress={() => setEditing({ location: l })}>
                  Rename
                </Button>
                {!l.isDefault && !l.archived && (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={working === l.id}
                    onPress={() =>
                      change(l, { isDefault: true }, `${l.name} is now the default location`)
                    }
                  >
                    Make default
                  </Button>
                )}
                {!l.isDefault && (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={working === l.id}
                    onPress={() =>
                      change(
                        l,
                        { archived: !l.archived },
                        l.archived ? 'Location restored' : 'Location archived',
                      )
                    }
                  >
                    {l.archived ? 'Restore' : 'Archive'}
                  </Button>
                )}
              </Row>
            ),
          },
        ]
      : []),
  ];

  return (
    <Stack gap={5}>
      <PageHeader
        title="Locations"
        description="Where your stock is kept: a shop, a warehouse, a shelf. New stock goes to the default location unless you pick another."
        actions={
          writable ? (
            <Button onPress={() => setEditing({ location: null })}>New location</Button>
          ) : undefined
        }
      />
      <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading locations">
        {(query.data ?? []).length === 0 ? (
          <EmptyState title="No locations yet">
            A default location is created automatically the first time you receive stock. You can
            also add one now.
          </EmptyState>
        ) : (
          <DataTable
            label="Locations"
            columns={columns}
            rows={query.data ?? []}
            rowKey={(l) => l.id}
          />
        )}
      </QueryBoundary>
      <NameDialog
        open={editing !== null}
        title={editing?.location ? 'Rename location' : 'New location'}
        label="Location name"
        initial={editing?.location?.name ?? ''}
        submitLabel={editing?.location ? 'Save' : 'Create location'}
        success={editing?.location ? 'Location renamed' : 'Location created'}
        onSubmit={async (name) => {
          if (editing?.location) await api.locations.update(editing.location.id, { name });
          else await api.locations.create({ name });
          await refresh();
        }}
        onClose={() => setEditing(null)}
      />
    </Stack>
  );
}
