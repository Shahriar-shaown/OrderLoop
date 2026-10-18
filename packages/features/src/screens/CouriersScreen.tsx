import type { CourierEntry } from '@orderloop/contracts';
import { Alert, Badge, PageHeader, Row, Section, Stack } from '@orderloop/ui';
import { CourierConnectionForm } from '../components/CourierConnectionForm';
import { QueryBoundary } from '../components/QueryBoundary';
import {
  COURIER_STATE_LABEL,
  COURIER_STATE_TONE,
  courierState,
  ENVIRONMENT_LABEL,
  useCouriers,
} from '../couriers';
import { useCan } from '../permissions';

function CourierSection({ entry, canManage }: { entry: CourierEntry; canManage: boolean }) {
  const state = courierState(entry);
  const env = entry.connection?.environment;
  return (
    <Section
      title={entry.name}
      description={
        entry.simulated
          ? 'For practice and demos. It books pretend parcels and nothing leaves this system.'
          : undefined
      }
      actions={
        <Row gap={2} wrap>
          {entry.simulated && <Badge tone="warning">SIMULATED</Badge>}
          <Badge tone={COURIER_STATE_TONE[state]} dot>
            {COURIER_STATE_LABEL[state]}
          </Badge>
          {env && !entry.simulated && <Badge tone="neutral">{ENVIRONMENT_LABEL[env]}</Badge>}
        </Row>
      }
    >
      <CourierConnectionForm entry={entry} canManage={canManage} />
    </Section>
  );
}

/** Courier connection settings (Settings → Couriers). The shipments page opens the same form in a side sheet. */
export function CouriersScreen() {
  const can = useCan();
  const query = useCouriers();
  return (
    <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading couriers">
      <Stack gap={5}>
        <PageHeader
          title="Couriers"
          description="Connect a delivery company so orders can be booked and followed from here."
        />
        {!can('couriers:manage') && (
          <Alert tone="info">Only an owner or admin can change courier connections.</Alert>
        )}
        <Alert tone="info" title="Your courier details stay on the server">
          Passwords and keys are encrypted when saved and are never sent back to this page or the
          app. To change one, enter the new value.
        </Alert>
        {query.data?.map((entry) => (
          <CourierSection key={entry.provider} entry={entry} canManage={can('couriers:manage')} />
        ))}
      </Stack>
    </QueryBoundary>
  );
}
