import { Alert, Button, Card, Stack, Text, useNavigation } from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useAuth, useSignOut } from '../../core/auth';
import { useApi, useRuntime } from '../../core/runtime';
import { messageFor } from '../../forms/errors';
import { formatLongDate } from '../../lib/format';
import { useSetTenantDeletion, useTenantDeletion } from '../../lib/deletion';
import { useSwitchWorkspace, useWorkspaces } from '../../lib/workspaces';

/** What replaces the app while the business is scheduled for deletion: the date, Cancel for the owner, a way out for everyone else. */
export function TenantDeletedScreen() {
  const api = useApi();
  const { home } = useRuntime();
  const { session } = useAuth();
  const status = useTenantDeletion();
  const setStatus = useSetTenantDeletion();
  const queryClient = useQueryClient();
  const workspaces = useWorkspaces();
  const switchTo = useSwitchWorkspace();
  const navigation = useNavigation();
  const { signOut, leaving } = useSignOut();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const data = status.data;
  if (!data?.scheduled || !data.purgeAfter || !session) return null;
  const others = (workspaces.data ?? []).filter((w) => w.id !== session.tenant.id);

  async function cancel() {
    setBusy('cancel');
    setError('');
    try {
      setStatus(await api.tenantDeletion.cancel());
      await queryClient.invalidateQueries();
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(null);
    }
  }
  async function leave(id: string) {
    setBusy(id);
    setError('');
    try {
      await switchTo(id);
      navigation.replace(home);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card variant="outlined" padding="md">
      <Stack gap={4}>
        <Alert tone="warning" title={`${data.businessName} is scheduled for deletion`}>
          {`This business is scheduled for deletion on ${formatLongDate(new Date(data.purgeAfter))}. Nobody can use it until then.`}
        </Alert>
        {data.canCancel ? (
          <Stack gap={2}>
            <Text>
              You are an owner, so you can cancel the deletion until then. Courier credentials and
              Meta connections that were deleted when it was requested are not restored: connect
              them again afterwards, and switch automation back on.
            </Text>
            <Stack direction="row">
              <Button loading={busy === 'cancel'} onPress={cancel}>
                Cancel deletion
              </Button>
            </Stack>
          </Stack>
        ) : (
          <Text>
            Only an owner of the business can cancel the deletion. Ask them if this was a mistake.
          </Text>
        )}
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Stack gap={2}>
          <Text variant="label">Other businesses</Text>
          {others.length === 0 ? (
            <Text tone="muted">You do not belong to another business.</Text>
          ) : (
            others.map((w) => (
              <Stack key={w.id} direction="row">
                <Button
                  variant="secondary"
                  loading={busy === w.id}
                  accessibilityLabel={`Switch to ${w.name}`}
                  onPress={() => leave(w.id)}
                >
                  {`Switch to ${w.name}`}
                </Button>
              </Stack>
            ))
          )}
        </Stack>
        <Stack direction="row">
          <Button variant="secondary" icon="logout" loading={leaving} onPress={signOut}>
            Sign out
          </Button>
        </Stack>
      </Stack>
    </Card>
  );
}

/** Shows the blocking screen instead of its children while the business is scheduled for deletion; otherwise the children. */
export function TenantDeletionGate({ children }: { children: ReactNode }) {
  const status = useTenantDeletion();
  if (status.data?.scheduled) return <TenantDeletedScreen />;
  return <>{children}</>;
}
