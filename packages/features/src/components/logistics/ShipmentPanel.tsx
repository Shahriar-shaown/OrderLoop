import {
  RESOLUTIONS,
  SIMULATED_EVENTS,
  type CourierEntry,
  type OrderDetail,
  type ShipmentDetail,
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
  Section,
  SelectField,
  Stack,
  Text,
  TextField,
  useToast,
} from '@orderloop/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  COURIER_NAME,
  ENVIRONMENT_LABEL,
  invalidateShipments,
  SIMULATED_EVENT_LABEL,
  useCouriers,
  useOrderShipments,
  useShipment,
  usable,
} from '../../lib/couriers';
import { COD_PAISA_ADVICE, hasPaisa, messageFor } from '../../forms/errors';
import { formatDayTime, formatWhen } from '../../lib/format';
import { useIdempotencyKey } from '../../forms/useIdempotencyKey';
import { useFormState } from '../../forms/forms';
import { CancelShipmentDialog } from './ShipmentDetail';
import { formatPrice } from '../../lib/money';
import { useCan } from '../../core/permissions';
import { useApi } from '../../core/runtime';
import { ShipmentStatusBadge } from './ShipmentStatusBadge';

const NOT_LIVE: ShipmentStatus[] = ['booking_failed', 'cancelled'];

/** Shown wherever a shipment appears. Nothing about a simulated shipment is real, and it must never look as if it were. */
function SimulatedBadge() {
  return <Badge tone="warning">SIMULATED</Badge>;
}

const RESOLUTION_LABEL: Record<(typeof RESOLUTIONS)[number], string> = {
  not_booked: 'The courier has no such booking',
  booked: 'The courier does have this booking',
  cancelled_at_courier: 'It was cancelled at the courier (by phone or in its panel)',
};

function ResolveDialog({
  shipment,
  open,
  onClose,
  fixed,
}: {
  shipment: ShipmentDetail;
  open: boolean;
  onClose: () => void;
  /** Present when only one answer makes sense (cancelling a booking at a courier that has no cancel call). */
  fixed?: (typeof RESOLUTIONS)[number];
}) {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const form = useFormState({
    resolution: fixed ?? 'not_booked',
    consignmentId: '',
    reason: '',
  });
  if (!open) return null;
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
          : `Open ${shipment.provider === 'pathao' ? 'Pathao' : 'the courier'}'s own panel and look for reference ${shipment.reference}. Say what you found. Booking again before this is settled could send two parcels.`}
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
          {...form.field('consignmentId')}
          autoCapitalize="none"
        />
      )}
      <TextField label="What did you see?" required {...form.field('reason')} />
    </FormDialog>
  );
}

function ShipmentCard({
  id,
  providerNames,
}: {
  id: string;
  providerNames: Record<string, string>;
}) {
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useShipment(id);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'cancel' | 'resolve' | 'markCancelled' | null>(null);
  const s = query.data;
  if (!s) return query.error ? <Alert tone="error">{messageFor(query.error)}</Alert> : null;

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
  return (
    <Stack gap={3}>
      <Row gap={2} wrap align="center">
        <ShipmentStatusBadge status={s.status} />
        <Text weight="bold">{providerNames[s.provider] ?? COURIER_NAME[s.provider]}</Text>
        {s.simulated && <SimulatedBadge />}
        {!s.simulated && s.environment === 'sandbox' && (
          <Badge tone="neutral">{ENVIRONMENT_LABEL.sandbox}</Badge>
        )}
        <Text variant="caption" tone="muted">{`Attempt ${s.attempt}`}</Text>
      </Row>

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
          ...(s.bookedAt ? [{ label: 'Booked', value: formatDayTime(s.bookedAt) }] : []),
          { label: 'Our reference', value: s.reference },
          ...(s.consignmentId
            ? [
                {
                  label: s.simulated ? 'Simulated parcel ID' : 'Courier parcel ID',
                  value: s.consignmentId,
                },
              ]
            : []),
          ...(s.trackingCode ? [{ label: 'Tracking code', value: s.trackingCode }] : []),
          ...(s.trackingUrl
            ? [
                {
                  label: 'Tracking page',
                  value: s.simulated ? (
                    <Text>{`${s.trackingUrl} (a simulated address; it opens nothing)`}</Text>
                  ) : (
                    <Link href={s.trackingUrl} external>
                      Open on the courier's site
                    </Link>
                  ),
                },
              ]
            : []),
          ...(s.providerStatus ? [{ label: "Courier's own status", value: s.providerStatus }] : []),
          { label: 'Cash to collect', value: formatPrice(s.codAmountMinor) },
          ...(s.deliveryFeeMinor !== null
            ? [{ label: 'Courier delivery fee', value: formatPrice(s.deliveryFeeMinor) }]
            : []),
          ...(s.lastEventAt ? [{ label: 'Last update', value: formatWhen(s.lastEventAt) }] : []),
        ]}
      />

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
            <Button variant="primary" onPress={() => setDialog('resolve')}>
              Settle this booking
            </Button>
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
                loading={busy === event}
                onPress={() => act(event, () => api.shipments.simulate(s.id, { event }))}
              >
                {SIMULATED_EVENT_LABEL[event]}
              </Button>
            ))}
          </Row>
        </Stack>
      )}

      <Stack gap={2}>
        <Text weight="bold">What the courier has told us</Text>
        {s.events.map((e) => (
          <Stack key={e.id} gap={1}>
            <Row gap={2} wrap align="center">
              <Text variant="caption" tone="muted">
                {formatWhen(e.createdAt)}
              </Text>
              <Badge tone="neutral">{e.source}</Badge>
              {e.mappedStatus && <ShipmentStatusBadge status={e.mappedStatus} />}
              {!e.applied && e.mappedStatus && <Badge tone="warning">Not applied</Badge>}
            </Row>
            {e.providerStatus && <Text>{`Courier's words: ${e.providerStatus}`}</Text>}
            {e.note && (
              <Text variant="caption" tone="muted">
                {e.note}
              </Text>
            )}
          </Stack>
        ))}
      </Stack>

      <CancelShipmentDialog
        shipment={s}
        open={dialog === 'cancel'}
        onClose={() => setDialog(null)}
      />
      <ResolveDialog shipment={s} open={dialog === 'resolve'} onClose={() => setDialog(null)} />
      <ResolveDialog
        shipment={s}
        open={dialog === 'markCancelled'}
        fixed="cancelled_at_courier"
        onClose={() => setDialog(null)}
      />
    </Stack>
  );
}

function BookForm({ order, couriers }: { order: OrderDetail; couriers: CourierEntry[] }) {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const options = couriers.filter(usable);
  const form = useFormState({
    provider: options[0]?.provider ?? '',
    weightKg: '',
    note: '',
    cityId: '',
    zoneId: '',
    areaId: '',
  });
  // The couriers can arrive after the form first renders (or change while it is open): never leave the choice empty or on a
  // courier that is no longer usable.
  const chosen = form.values.provider;
  const firstUsable = options[0]?.provider;
  useEffect(() => {
    if (firstUsable && !options.some((c) => c.provider === chosen))
      form.set('provider', firstUsable);
  }, [chosen, firstUsable]);
  // One key per intended booking. It is reused when a request fails without an answer (so a retry cannot book twice) and
  // replaced once the server has answered, so the next booking is a new one.
  const { key, renew } = useIdempotencyKey();
  const [quote, setQuote] = useState<string | null>(null);
  const [busy, setBusy] = useState<'quote' | 'book' | null>(null);

  const courier = options.find((c) => c.provider === form.values.provider);
  const wantsPlaces = !!courier?.capabilities.locations;
  const place = (kind: 'cities' | 'zones' | 'areas', parent: string) =>
    useQuery({
      queryKey: ['courierLocations', form.values.provider, kind, parent],
      queryFn: () =>
        api.couriers.locations(courier!.provider, {
          kind,
          ...(parent ? { parentId: Number(parent) } : {}),
        }),
      enabled: wantsPlaces && (kind === 'cities' || !!parent),
      retry: false,
    });
  const cities = place('cities', '');
  const zones = place('zones', form.values.cityId);
  const areas = place('areas', form.values.zoneId);

  const paisa = hasPaisa(order);

  if (!options.length)
    return (
      <Alert tone="info" title="No courier is connected">
        <Stack gap={2}>
          <Text>Connect a courier (or turn on the simulated one) to book parcels.</Text>
          <Link href="/settings/couriers">Go to courier settings</Link>
        </Stack>
      </Alert>
    );

  const pick = (list?: { id: number; name: string }[]) => [
    { value: '', label: 'Let the courier decide from the address' },
    ...(list ?? []).map((l) => ({ value: String(l.id), label: l.name })),
  ];
  const num = (v: string) => (v ? Number(v) : undefined);
  const body = () => ({
    provider: courier!.provider,
    ...(form.values.weightKg ? { weightKg: Number(form.values.weightKg) } : {}),
    ...(form.values.note.trim() ? { note: form.values.note.trim() } : {}),
    ...(num(form.values.cityId) ? { cityId: num(form.values.cityId)! } : {}),
    ...(num(form.values.zoneId) ? { zoneId: num(form.values.zoneId)! } : {}),
    ...(num(form.values.areaId) ? { areaId: num(form.values.areaId)! } : {}),
  });

  async function getQuote() {
    setBusy('quote');
    try {
      const q = await api.shipments.quote(order.id, body());
      setQuote(
        q.feeMinor !== null
          ? `${q.simulated ? 'Simulated estimate' : 'Estimate'}: ${formatPrice(q.feeMinor)}${q.serviceable === false ? ' — the courier says it does not serve this address' : ''}${q.message ? `. ${q.message}` : ''}`
          : (q.message ?? 'No estimate available.'),
      );
    } catch (error) {
      setQuote(messageFor(error));
    } finally {
      setBusy(null);
    }
  }

  async function submit() {
    setBusy('book');
    form.clear();
    try {
      const result = await api.shipments.book(order.id, { ...body(), idempotencyKey: key });
      // The server answered: whatever it says, the next press is a new booking.
      renew();
      await invalidateShipments(queryClient);
      if (result.status === 'booked')
        toast.success(result.simulated ? 'Booked (simulated)' : 'Booked with the courier');
      else if (result.status === 'booking_failed')
        toast.error('The courier did not take the booking. Details are below.');
      else
        toast.error(
          'The booking could not be confirmed. Read the note below before doing anything else.',
        );
    } catch (error) {
      // No answer we can rely on (a network error): keep the key, so pressing again retries the same booking.
      form.setFormError(
        `${messageFor(error)} Pressing Book again is safe: it will not create a second parcel.`,
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <Stack gap={3}>
      {form.formError ? <Alert tone="error">{form.formError}</Alert> : null}
      {paisa && (
        <Alert tone="warning" title="This order cannot be booked with a courier">
          {COD_PAISA_ADVICE}
        </Alert>
      )}
      <SelectField
        label="Courier"
        value={form.values.provider}
        onChange={(v) => {
          form.set('provider', v);
          setQuote(null);
        }}
        options={options.map((c) => ({
          value: c.provider,
          label: c.simulated ? `${c.name} (simulated)` : c.name,
        }))}
      />
      {courier?.simulated && (
        <Alert tone="warning">
          Simulated courier. Booking creates a pretend parcel for practice. Nothing is sent
          anywhere.
        </Alert>
      )}
      {courier && !courier.simulated && courier.connection?.environment === 'sandbox' && (
        <Alert tone="info">{`This courier is connected to its ${ENVIRONMENT_LABEL.sandbox.toLowerCase()}.`}</Alert>
      )}
      <Text tone="muted">{`Cash to collect: ${formatPrice(order.codAmountMinor)}. Booking does not change the order: the courier's updates do.`}</Text>
      {wantsPlaces && (
        <>
          <SelectField
            label="City (optional)"
            value={form.values.cityId}
            onChange={(v) => {
              form.set('cityId', v);
              form.set('zoneId', '');
              form.set('areaId', '');
            }}
            options={pick(cities.data)}
          />
          {form.values.cityId && (
            <SelectField
              label="Zone (optional)"
              value={form.values.zoneId}
              onChange={(v) => {
                form.set('zoneId', v);
                form.set('areaId', '');
              }}
              options={pick(zones.data)}
            />
          )}
          {form.values.zoneId && (
            <SelectField
              label="Area (optional)"
              value={form.values.areaId}
              onChange={(v) => form.set('areaId', v)}
              options={pick(areas.data)}
            />
          )}
        </>
      )}
      <TextField
        label="Parcel weight in kg (optional)"
        keyboardType="decimal-pad"
        {...form.field('weightKg')}
      />
      <TextField label="Note for the courier (optional)" {...form.field('note')} />
      {quote && <Alert tone="info">{quote}</Alert>}
      <Row gap={2} wrap>
        {courier?.capabilities.quote && (
          <Button variant="secondary" loading={busy === 'quote'} onPress={getQuote}>
            Get estimate
          </Button>
        )}
        <Button loading={busy === 'book'} disabled={paisa} onPress={submit}>
          {courier?.simulated ? 'Book simulated parcel' : 'Book courier'}
        </Button>
      </Row>
    </Stack>
  );
}

/**
 * "Courier & tracking" on the order page: the booking form when the order is ready to ship and has no live parcel, then each
 * shipment with its status, reference, tracking and actions. The courier's updates move the order for you.
 */
export function ShipmentPanel({ order }: { order: OrderDetail }) {
  const can = useCan();
  const shipments = useOrderShipments(order.id);
  const couriers = useCouriers();
  const list = shipments.data ?? [];
  const live = list.some((s) => !NOT_LIVE.includes(s.status));
  const names = Object.fromEntries((couriers.data ?? []).map((c) => [c.provider, c.name]));
  const canBook = can('orders:write') && order.status === 'ready_to_ship' && !live;

  return (
    <Section title="Courier & tracking">
      <Stack gap={5}>
        {!list.length && !canBook && (
          <Text tone="muted">
            {order.status === 'confirmed' || order.status === 'pending_confirmation'
              ? 'Once the order is ready to ship you can book a courier here.'
              : order.status === 'ready_to_ship'
                ? 'No courier is booked yet.'
                : order.status === 'cancelled'
                  ? 'No courier was booked for this order.'
                  : 'No courier shipment is linked to this order.'}
          </Text>
        )}
        {shipments.isError && <Alert tone="error">{messageFor(shipments.error)}</Alert>}
        {canBook && couriers.data && <BookForm order={order} couriers={couriers.data} />}
        {list.map((s) => (
          <ShipmentCard key={s.id} id={s.id} providerNames={names} />
        ))}
      </Stack>
    </Section>
  );
}
