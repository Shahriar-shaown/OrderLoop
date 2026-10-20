import type { Role, Workspace } from '@orderloop/contracts';
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  Grid,
  PageHeader,
  Row,
  Stack,
  Text,
  useNavigation,
  useToast,
  type Tone,
} from '@orderloop/ui';
import { useState } from 'react';
import { useAuth } from '../../core/auth';
import { QueryBoundary } from '../../shell/QueryBoundary';
import { messageFor } from '../../forms/errors';
import { useRuntime } from '../../core/runtime';
import { useSwitchWorkspace, useWorkspaces } from '../../lib/workspaces';

const ROLE_TONE: Record<Role, Tone> = {
  OWNER: 'brand',
  ADMIN: 'info',
  MANAGER: 'success',
  STAFF: 'neutral',
  ACCOUNTANT: 'warning',
};

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

  return (
    <Stack gap={5}>
      <PageHeader
        title="Your businesses"
        description="Each business keeps its own products, stock and team."
        actions={
          <Button icon="plus" onPress={() => navigation.push('/workspaces/new')}>
            New business
          </Button>
        }
      />
      <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading your businesses">
        {(query.data ?? []).length === 0 ? (
          <EmptyState title="No businesses yet" icon="store" />
        ) : (
          <Grid columns={{ mobile: 1, tablet: 2, desktop: 3 }} gap={4}>
            {(query.data ?? []).map((w) => {
              const current = w.id === session?.tenant.id;
              return (
                <Card key={w.id} style={{ flex: 1 }}>
                  <Stack gap={4}>
                    <Row gap={3}>
                      <Avatar name={w.name} size={44} />
                      <Stack gap={1} grow>
                        <Text variant="heading">{w.name}</Text>
                        <Row gap={2} wrap>
                          <Badge tone={ROLE_TONE[w.role]}>{w.role.toLowerCase()}</Badge>
                          {current ? (
                            <Badge tone="success" dot>
                              Current
                            </Badge>
                          ) : null}
                        </Row>
                      </Stack>
                    </Row>
                    <Button
                      variant={current ? 'primary' : 'secondary'}
                      iconRight="arrow-right"
                      fullWidth
                      loading={working === w.id}
                      accessibilityLabel={`${current ? 'Continue' : 'Switch'} to ${w.name}`}
                      onPress={() => open(w)}
                    >
                      {current ? 'Continue' : 'Switch'}
                    </Button>
                  </Stack>
                </Card>
              );
            })}
          </Grid>
        )}
      </QueryBoundary>
    </Stack>
  );
}
