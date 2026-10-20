import {
  RESOLUTIONS,
  SIMULATED_EVENTS,
  type ShipmentDetail as ShipmentDetailData,
  type ShipmentEvent,
  type ShipmentStatus,
} from '@orderloop/contracts';
import {
  Alert,
  Badge,
  Button,
  FormDialog,
  KeyValueList,
  Link,
  Row,
  SelectField,
  Skeleton,
  Stack,
  Text,
  TextField,
  Timeline,
  useToast,
  type TimelineStep,
} from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  COURIER_NAME,
  ENVIRONMENT_LABEL,
  invalidateShipments,
  SHIPMENT_LABEL,
  SIMULATED_EVENT_LABEL,
  useShipment,
} from '../../lib/couriers';
import { messageFor } from '../../forms/errors';
import { formatDayTime } from '../../lib/format';
import { useFormState } from '../../forms/forms';
import { formatPrice } from '../../lib/money';
import { useCan } from '../../core/permissions';
import { useApi } from '../../core/runtime';
import { ShipmentStatusBadge } from './ShipmentStatusBadge';

const RESOLUTION_LABEL: Record<(typeof RESOLUTIONS)[number], string> = {
  not_booked: 'The courier has no such booking',
  booked: 'The courier does have this booking',
  cancelled_at_courier: 'It was cancelled at the courier (by phone or in its panel)',
};

const PROBLEM: ShipmentStatus[] = ['booking_failed', 'delivery_failed'];
const DONE: ShipmentStatus[] = ['delivered', 'partial_delivered', 'returned'];

/** The shipment's real history, oldest first: the courier's own words, our status, and whether it changed anything. */
export function shipmentTimeline(events: ShipmentEvent[]): TimelineStep[] {
  const ordered = [...events].sort(
    (a, b) =>
      new Date(a.occurredAt ?? a.createdAt).getTime() -
      new Date(b.occurredAt ?? b.createdAt).getTime(),
  );
  const lastApplied = ordered.map((e) => e.applied && !!e.mappedStatus).lastIndexOf(true);
  return ordered.map((e, i) => {
    const status = e.mappedStatus;
    const applied = e.applied && !!status;
    const detail = [
      e.providerStatus ? `Courier’s words: ${e.providerStatus}` : null,
      status && !e.applied ? 'Not applied: it changed nothing here.' : null,
      e.note,
    ].filter(Boolean);
    return {
      key: e.id,
      title: status ? SHIPMENT_LABEL[status] : (e.providerStatus ?? 'Update received'),
      meta: `${formatDayTime(e.occurredAt ?? e.createdAt)} · ${e.source}`,
      detail: detail.length ? (
        <Stack gap={1}>
          {detail.map((d) => (
            <Text key={String(d)} variant="small" tone="muted">
              {String(d)}
            </Text>
          ))}
        </Stack>
      ) : undefined,
      state:
        status && PROBLEM.includes(status) && applied
          ? 'problem'
          : !applied
            ? 'todo'
            : i === lastApplied && !DONE.includes(status)
              ? 'current'
              : 'done',
    };
  });
}

/** What a person found when they looked in the courier's own panel. */
export function ResolveShipmentDialog({
  shipment,
  onClose,
  fixed,
}: {
  shipment: ShipmentDetailData;
  onClose: () => void;
  /** Present when only one answer makes sense (cancelling a booking at a courier that has no cancel call). */
  fixed?: (typeof RESOLUTIONS)[number];
}) {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const form = useFormState({ resolution: fixed ?? 'not_booked', consignmentId: '', reason: '' });
  async function submit() {
    const v = form.values;
    const ok = await form.run(async () => {
      await api.shipments.resolve(shipment.id, {
        resolution: v.resolution as (typeof RESOLUTIONS)[number],
        reason: v.reason.trim(),
        ...(v.resolution === 'booked' && v.consignmentId.trim()
          ? { consignmentId: v.consignmentId.trim() }
          : {}),
      });
      await invalidateShipments(queryClient);
    });
    if (ok) {
      toast.success('Recorded');
      onClose();
    }
  }
  return (
    <FormDialog
      open
      onClose={onClose}
      title={fixed ? 'Mark cancelled at the courier' : 'Settle this booking'}
      onSubmit={submit}
      submitLabel="Save"
      busy={form.busy}
      error={form.formError}
    >
      <Text>
        {fixed
          ? 'This courier cannot cancel through its API. Cancel the parcel in its own panel or by phone first, then record it here.'
          : `Open ${COURIER_NAME[shipment.provider]}’s own panel and look for reference ${shipment.reference}. Say what you found. Booking again before this is settled could send two parcels.`}
      </Text>
      {!fixed && (
        <SelectField
          label="What did you find?"
          value={form.values.resolution}
          onChange={(v) => form.set('resolution', v)}
          options={RESOLUTIONS.map((r) => ({ value: r, label: RESOLUTION_LABEL[r] }))}
        />
      )}
      {form.values.resolution === 'booked' && (
        <TextField
          label="Courier's consignment ID (optional)"
          autoCapitalize="none"
          {...form.field('consignmentId')}
        />
      )}
      <TextField label="What did you see?" required {...form.field('reason')} />
    </FormDialog>
  );
}

export function CancelShipmentDialog({
  shipment,
  onClose,
}: {
  shipment: ShipmentDetailData;
  onClose: () => void;
}) {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const form = useFormState({ reason: '' });
  async function submit() {
    const reason = form.values.reason.trim();
    if (reason.length < 3) return form.setErrors({ reason: 'Say why (at least 3 characters)' });
    const ok = await form.run(async () => {
      await api.shipments.cancel(shipment.id, { reason });
      await invalidateShipments(queryClient);
    });
    if (ok) {
      toast.success('Shipment cancelled');
      onClose();
    }
  }
  return (
    <FormDialog
      open
      onClose={onClose}
      title="Cancel this shipment"
      onSubmit={submit}
      submitLabel="Cancel shipment"
      danger
      busy={form.busy}
      error={form.formError}
      size="sm"
    >
      <TextField label="Reason" required autoFocus {...form.field('reason')} />
    </FormDialog>
  );
}

/**
 * One parcel in full, from the shipments page: header, order, cash to collect, fee, tracking, the real event history as a
 * timeline, and the actions the API allows for it (refresh, cancel, settle, mark cancelled, and the simulate buttons).
 */
export function ShipmentDetail({ id }: { id: string }) {
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useShipment(id);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'cancel' | 'resolve' | 'markCancelled' | null>(null);
  const s = query.data;

  if (query.isError)
    return (
      <Alert
        tone="error"
        action={
          <Button variant="secondary" onPress={() => query.refetch()}>
            Try again
          </Button>
        }
      >
        {messageFor(query.error)}
      </Alert>
    );
  if (!s)
    return (
      <Stack gap={3} accessibilityLabel="Loading shipment">
        <Skeleton width="60%" />
        <Skeleton width="90%" />
        <Skeleton width="75%" />
      </Stack>
    );

  async function act(name: string, run: () => Promise<unknown>, done?: string) {
    setBusy(name);
    try {
      await run();
      await invalidateShipments(queryClient);
      if (done) toast.success(done);
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(null);
    }
  }

  const write = can('orders:write');
  const steps = shipmentTimeline(s.events);
  return (
    <Stack gap={4}>
      <Stack gap={2}>
        <Row gap={2} wrap align="center" justify="between">
          <Text variant="title" role="heading" aria-level={3}>
            {s.consignmentId ?? s.reference}
          </Text>
          <ShipmentStatusBadge status={s.status} />
        </Row>
        <Row gap={2} wrap align="center">
          <Text tone="muted">{COURIER_NAME[s.provider]}</Text>
          {s.simulated && <Badge tone="warning">SIMULATED · not a real parcel</Badge>}
          {!s.simulated && s.environment === 'sandbox' && (
            <Badge tone="neutral">{ENVIRONMENT_LABEL.sandbox}</Badge>
          )}
          <Text variant="caption" tone="muted">{`Attempt ${s.attempt}`}</Text>
        </Row>
      </Stack>

      {s.simulated && (
        <Alert tone="warning">
          This is a simulated shipment. No courier knows about it and no parcel exists.
        </Alert>
      )}
      {s.failureReason && (
        <Alert tone={s.status === 'booking_uncertain' ? 'warning' : 'error'}>
          {s.failureReason}
        </Alert>
      )}

      <KeyValueList
        layout="inline"
        items={[
          {
            label: 'Order',
            value: <Link href={`/orders/${s.orderId}`} weight="medium">{`#${s.orderNumber}`}</Link>,
          },
          { label: 'COD to collect', value: formatPrice(s.codAmountMinor) },
          {
            label: 'Delivery fee',
            value: s.deliveryFeeMinor !== null ? formatPrice(s.deliveryFeeMinor) : '—',
          },
          { label: 'Our reference', value: s.reference },
          ...(s.trackingCode ? [{ label: 'Tracking code', value: s.trackingCode }] : []),
          ...(s.providerStatus ? [{ label: 'Courier’s own status', value: s.providerStatus }] : []),
          ...(s.lastEventAt ? [{ label: 'Last update', value: formatDayTime(s.lastEventAt) }] : []),
          ...(s.trackingUrl
            ? [
                {
                  label: 'Tracking page',
                  value: s.simulated ? (
                    <Text variant="small" tone="muted">
                      A simulated address; it opens nothing
                    </Text>
                  ) : (
                    <Link href={s.trackingUrl} external weight="medium">
                      {`Track on ${COURIER_NAME[s.provider]}`}
                    </Link>
                  ),
                },
              ]
            : []),
        ]}
      />

      <Stack gap={3}>
        <Text variant="fine" tone="muted">
          TRACKING
        </Text>
        {steps.length ? (
          <Timeline steps={steps} label="Shipment history" />
        ) : (
          <Text tone="muted">The courier has not reported anything yet.</Text>
        )}
      </Stack>

      {write && (
        <Row gap={2} wrap>
          {s.actions.canRefresh && (
            <Button
              variant="secondary"
              loading={busy === 'refresh'}
              onPress={() =>
                act('refresh', () => api.shipments.refresh(s.id), 'Checked with the courier')
              }
            >
              Check status now
            </Button>
          )}
          {s.actions.needsResolution && (
            <Button onPress={() => setDialog('resolve')}>Settle this booking</Button>
          )}
          {s.actions.canCancel && (
            <Button variant="danger" onPress={() => setDialog('cancel')}>
              Cancel shipment
            </Button>
          )}
          {s.actions.canMarkCancelled && (
            <Button variant="secondary" onPress={() => setDialog('markCancelled')}>
              Mark cancelled at the courier
            </Button>
          )}
        </Row>
      )}

      {write && s.actions.canSimulate && (
        <Stack gap={2}>
          <Text variant="caption" tone="muted">
            Simulated courier: make it report an update, as a real courier would.
          </Text>
          <Row gap={2} wrap>
            {SIMULATED_EVENTS.map((event) => (
              <Button
                key={event}
                variant="secondary"
                size="sm"
                loading={busy === event}
                onPress={() => act(event, () => api.shipments.simulate(s.id, { event }))}
              >
                {SIMULATED_EVENT_LABEL[event]}
              </Button>
            ))}
          </Row>
        </Stack>
      )}

      {dialog === 'cancel' && <CancelShipmentDialog shipment={s} onClose={() => setDialog(null)} />}
      {dialog === 'resolve' && (
        <ResolveShipmentDialog shipment={s} onClose={() => setDialog(null)} />
      )}
      {dialog === 'markCancelled' && (
        <ResolveShipmentDialog
          shipment={s}
          fixed="cancelled_at_courier"
          onClose={() => setDialog(null)}
        />
      )}
    </Stack>
  );
}
