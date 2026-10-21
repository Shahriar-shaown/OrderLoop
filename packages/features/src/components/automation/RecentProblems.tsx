import type { Delivery, Run } from '@orderloop/contracts';
import { Badge, Button, Card, Section, Stack, Text, useToast } from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useApi } from '../../core/runtime';
import { messageFor } from '../../forms/errors';
import {
  DELIVERY_CHANNEL_LABEL,
  invalidateAutomation,
  KIND_INFO,
  useFailedDeliveries,
  useFailedRuns,
} from '../../lib/automation';
import { formatWhen } from '../../lib/format';
import { QueryBoundary } from '../../shell/QueryBoundary';

/** The server's short reason, with its "transient:" or "permanent:" tag turned into what it means for the person. */
function Reason({ error }: { error: string | null }) {
  if (!error)
    return (
      <Text variant="small" tone="muted">
        No details were recorded.
      </Text>
    );
  const permanent = error.startsWith('permanent:');
  const detail = error.replace(/^(transient|permanent):\s*/, '');
  return (
    <Stack direction="row" gap={1} wrap>
      <Text variant="small" tone="danger">
        {permanent ? 'It cannot be delivered:' : 'A temporary problem:'}
      </Text>
      <Text variant="small" tone="danger" verbatim>
        {detail}
      </Text>
    </Stack>
  );
}

function Problem({
  title,
  when,
  attempts,
  error,
  retry,
  children,
}: {
  title: string;
  when: string;
  attempts: number;
  error: string | null;
  retry: (() => Promise<unknown>) | undefined;
  children?: ReactNode;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function press() {
    if (!retry) return;
    setBusy(true);
    try {
      await retry();
      toast.success('Queued to try again');
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card variant="filled" padding="sm">
      <Stack direction="row" gap={3} align="center" justify="between" wrap>
        <Stack gap={1} grow style={{ minWidth: 200 }}>
          <Stack direction="row" gap={2} align="center" wrap>
            <Text variant="label">{title}</Text>
            <Badge tone="error" dot>
              Failed
            </Badge>
            {children}
          </Stack>
          <Stack direction="row" gap={2} wrap>
            <Text variant="caption" tone="muted">
              {when}
            </Text>
            <Text variant="caption" tone="muted">
              {attempts === 1 ? 'Tried 1 time' : `Tried ${attempts} times`}
            </Text>
          </Stack>
          <Reason error={error} />
        </Stack>
        {retry ? (
          <Button size="sm" variant="secondary" icon="refresh" loading={busy} onPress={press}>
            Retry
          </Button>
        ) : null}
      </Stack>
    </Card>
  );
}

/** Runs and deliveries that went wrong, with the reason and, for people who manage automation, a way to try again. */
export function RecentProblems({ canManage }: { canManage: boolean }) {
  const api = useApi();
  const client = useQueryClient();
  const runs = useFailedRuns();
  const deliveries = useFailedDeliveries();
  const after = <T,>(call: Promise<T>) =>
    call.then((r) => invalidateAutomation(client).then(() => r));
  const none = (runs.data?.items.length ?? 0) + (deliveries.data?.items.length ?? 0) === 0;

  return (
    <Section
      title="Recent runs and problems"
      description="Runs and deliveries that failed. Trying one again never sends anything twice."
    >
      <QueryBoundary
        isPending={runs.isPending || deliveries.isPending}
        isError={runs.isError || deliveries.isError}
        error={runs.error ?? deliveries.error}
        data={runs.data && deliveries.data ? true : undefined}
        fetchStatus={runs.fetchStatus}
        refetch={() => {
          void runs.refetch();
          void deliveries.refetch();
        }}
        label="Loading problems"
      >
        {none ? (
          <Text tone="muted">Nothing has failed recently. Everything that ran was delivered.</Text>
        ) : (
          <Stack gap={3}>
            {runs.data?.items.map((run: Run) => (
              <Problem
                key={run.id}
                title={`${KIND_INFO[run.kind].name}: the check did not finish`}
                when={formatWhen(run.createdAt)}
                attempts={run.attempts}
                error={run.error}
                retry={canManage ? () => after(api.automation.retryRun(run.id)) : undefined}
              />
            ))}
            {deliveries.data?.items.map((d: Delivery) => (
              <Problem
                key={d.id}
                title={`${KIND_INFO[d.kind].name}: ${DELIVERY_CHANNEL_LABEL[d.channel]} not delivered`}
                when={formatWhen(d.createdAt)}
                attempts={d.attempts}
                error={d.lastError}
                retry={canManage ? () => after(api.automation.retryDelivery(d.id)) : undefined}
              />
            ))}
          </Stack>
        )}
      </QueryBoundary>
    </Section>
  );
}
