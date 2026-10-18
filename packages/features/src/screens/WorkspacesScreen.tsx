import type { Workspace } from '@orderloop/contracts';
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  PageHeader,
  Row,
  Stack,
  Text,
  useNavigation,
  useToast,
  type Column,
} from '@orderloop/ui';
import { useState } from 'react';
import { useAuth } from '../auth';
import { QueryBoundary } from '../components/QueryBoundary';
import { messageFor } from '../errors';
import { useRuntime } from '../runtime';
import { useSwitchWorkspace, useWorkspaces } from '../workspaces';

/** Every business you belong to, your role in each, and a way into the one you want. */
export function WorkspacesScreen() {
  const { session } = useAuth();
  const { home } = useRuntime();
  const query = useWorkspaces();
  const switchTo = useSwitchWorkspace();
  const navigation = useNavigation();
  const toast = useToast();
  const [working, setWorking] = useState<string | null>(null);

  async function open(w: Workspace) {
    setWorking(w.id);
    try {
      if (w.id !== session?.tenant.id) await switchTo(w.id);
      navigation.replace(home);
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setWorking(null);
    }
  }

  const columns: Column<Workspace>[] = [
    {
      key: 'name',
      header: 'Business',
      flex: 3,
      minWidth: 180,
      render: (w) => (
        <Row gap={2} wrap>
          <Text>{w.name}</Text>
          {w.id === session?.tenant.id ? <Badge tone="info">Current</Badge> : null}
        </Row>
      ),
    },
    {
      key: 'role',
      header: 'Your role',
      flex: 1,
      minWidth: 100,
      render: (w) => <Badge>{w.role.toLowerCase()}</Badge>,
    },
    {
      key: 'open',
      header: 'Open',
      flex: 1,
      minWidth: 100,
      render: (w) => (
        <Button size="sm" variant="secondary" loading={working === w.id} onPress={() => open(w)}>
          {w.id === session?.tenant.id ? 'Continue' : 'Switch'}
        </Button>
      ),
    },
  ];

  return (
    <Stack gap={5}>
      <PageHeader
        title="Your businesses"
        description="Each business keeps its own products, stock and team."
        actions={<Button onPress={() => navigation.push('/workspaces/new')}>New business</Button>}
      />
      <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading your businesses">
        {(query.data ?? []).length === 0 ? (
          <EmptyState title="No businesses yet" />
        ) : (
          <DataTable
            label="Businesses"
            columns={columns}
            rows={query.data ?? []}
            rowKey={(w) => w.id}
          />
        )}
      </QueryBoundary>
    </Stack>
  );
}
