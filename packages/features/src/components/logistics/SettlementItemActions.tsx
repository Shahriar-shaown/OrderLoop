import type { Discrepancy, SettlementItem } from '@orderloop/contracts';
import {
  Alert,
  Badge,
  Button,
  FormDialog,
  Row,
  SelectField,
  Stack,
  Text,
  TextField,
  useToast,
} from '@orderloop/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { DISCREPANCY_LABEL, invalidateFinance } from '../../lib/finance';
import { formatWhen } from '../../lib/format';
import { useFormState } from '../../forms/forms';
import { useCan } from '../../core/permissions';
import { useApi } from '../../core/runtime';

/** Find the parcel by order number, then pick which of that order's real parcels the line belongs to. */
function MatchDialog({ item, onClose }: { item: SettlementItem; onClose: () => void }) {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const form = useFormState({ orderNumber: '', shipmentId: '', reason: '' });
  const [search, setSearch] = useState('');
  const found = useQuery({
    queryKey: ['finance', 'find-parcels', search],
    enabled: search.length > 0,
    queryFn: async () => {
      const page = await api.orders.list({ search, limit: 5 } as never);
      const order = page.items.find((o) => String(o.orderNumber) === search);
      if (!order) return { order: null, shipments: [] };
      return {
        order,
        shipments: (await api.shipments.forOrder(order.id)).filter(
          (s) => !s.simulated && s.status !== 'booking_failed',
        ),
      };
    },
  });
  async function submit() {
    if (!form.values.shipmentId)
      return form.setErrors({ shipmentId: 'Find the order and choose its parcel' });
    if (form.values.reason.trim().length < 3)
      return form.setErrors({ reason: 'Say why (at least 3 characters)' });
    const ok = await form.run(async () => {
      await api.finance.matchItem(item.id, {
        shipmentId: form.values.shipmentId,
        reason: form.values.reason.trim(),
      });
      await invalidateFinance(queryClient);
    });
    if (ok) {
      toast.success('Matched. The decision is on the line’s history.');
      onClose();
    }
  }
  const shipments = found.data?.shipments ?? [];
  return (
    <FormDialog
      open
      onClose={onClose}
      title={`Match line ${item.lineNo} by hand`}
      onSubmit={submit}
      submitLabel="Match"
      busy={form.busy}
      error={form.formError}
    >
      <Text>{item.matchNote ?? ''}</Text>
      <Row gap={2} wrap align="end">
        <TextField label="Order number" keyboardType="number-pad" {...form.field('orderNumber')} />
        <Button
          variant="secondary"
          onPress={() => setSearch(form.values.orderNumber.trim().replace(/^#/, ''))}
        >
          Find
        </Button>
      </Row>
      {found.data && !found.data.order && <Alert tone="warning">No such order.</Alert>}
      {found.data?.order && shipments.length === 0 && (
        <Alert tone="warning">That order has no real courier parcel to match.</Alert>
      )}
      {shipments.length > 0 && (
        <SelectField
          label="Parcel"
          value={form.values.shipmentId}
          error={form.errors.shipmentId}
          onChange={(v) => form.set('shipmentId', v)}
          options={[
            { value: '', label: 'Choose a parcel' },
            ...shipments.map((s) => ({
              value: s.id,
              label: `${s.reference} · ${s.provider} · ${s.status.replace(/_/g, ' ')}`,
            })),
          ]}
        />
      )}
      <TextField label="Why are you sure?" required {...form.field('reason')} />
    </FormDialog>
  );
}

function ReasonDialog({
  title,
  submit,
  onClose,
  danger,
}: {
  title: string;
  submit: (reason: string) => Promise<unknown>;
  onClose: () => void;
  danger?: boolean;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const form = useFormState({ reason: '' });
  async function go() {
    if (form.values.reason.trim().length < 3)
      return form.setErrors({ reason: 'Say why (at least 3 characters)' });
    const ok = await form.run(async () => {
      await submit(form.values.reason.trim());
      await invalidateFinance(queryClient);
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
      title={title}
      onSubmit={go}
      submitLabel="Confirm"
      danger={danger ?? false}
      busy={form.busy}
      error={form.formError}
      size="sm"
    >
      <TextField label="Reason" required autoFocus {...form.field('reason')} />
    </FormDialog>
  );
}

function History({ id, onClose }: { id: string; onClose: () => void }) {
  const api = useApi();
  const query = useQuery({
    queryKey: ['finance', 'item', id],
    queryFn: () => api.finance.item(id),
  });
  return (
    <FormDialog
      open
      onClose={onClose}
      title="History of this line"
      onSubmit={onClose}
      submitLabel="Close"
    >
      <Stack gap={3}>
        {query.data?.history.map((h) => (
          <Stack key={h.id} gap={1}>
            <Row gap={2} wrap>
              <Badge tone="neutral">{h.action.replace(/_/g, ' ')}</Badge>
              <Text
                variant="caption"
                tone="muted"
              >{`${formatWhen(h.createdAt)}${h.actorName ? ` · ${h.actorName}` : ''}`}</Text>
            </Row>
            {h.note && <Text>{h.note}</Text>}
          </Stack>
        ))}
      </Stack>
    </FormDialog>
  );
}

/** What a person may do with one statement line. Only offered to those who may adjust finances; the API checks it again. */
export function SettlementItemActions({ item }: { item: SettlementItem }) {
  const api = useApi();
  const can = useCan();
  const [dialog, setDialog] = useState<'match' | 'unmatch' | 'ignore' | 'history' | null>(null);
  const adjust = can('finance:adjust');
  const close = () => setDialog(null);
  return (
    <Row gap={2} wrap>
      <Button size="sm" variant="secondary" onPress={() => setDialog('history')}>
        History
      </Button>
      {adjust && (item.matchStatus === 'unmatched' || item.matchStatus === 'ambiguous') && (
        <Button size="sm" onPress={() => setDialog('match')}>
          Match
        </Button>
      )}
      {adjust && item.matchStatus === 'matched' && (
        <Button size="sm" variant="secondary" onPress={() => setDialog('unmatch')}>
          Undo match
        </Button>
      )}
      {adjust && ['unmatched', 'ambiguous', 'unallocated'].includes(item.matchStatus) && (
        <Button size="sm" variant="secondary" onPress={() => setDialog('ignore')}>
          Not ours
        </Button>
      )}
      {dialog === 'match' && <MatchDialog item={item} onClose={close} />}
      {dialog === 'unmatch' && (
        <ReasonDialog
          title={`Undo the match on line ${item.lineNo}`}
          submit={(r) => api.finance.unmatchItem(item.id, r)}
          onClose={close}
        />
      )}
      {dialog === 'ignore' && (
        <ReasonDialog
          title={`Set line ${item.lineNo} aside as not ours`}
          submit={(r) => api.finance.ignoreItem(item.id, r)}
          onClose={close}
          danger
        />
      )}
      {dialog === 'history' && <History id={item.id} onClose={close} />}
    </Row>
  );
}

/** Resolve a discrepancy with a note, or (for a shortfall) accept it as a loss. */
export function DiscrepancyActions({ d }: { d: Discrepancy }) {
  const api = useApi();
  const can = useCan();
  const [dialog, setDialog] = useState<'resolve' | 'waive' | null>(null);
  if (d.status !== 'open' || !can('finance:adjust')) return null;
  return (
    <Row gap={2} wrap>
      <Button size="sm" variant="secondary" onPress={() => setDialog('resolve')}>
        Resolve
      </Button>
      {d.type === 'short_paid' && (
        <Button size="sm" variant="danger" onPress={() => setDialog('waive')}>
          Accept the loss
        </Button>
      )}
      {dialog && (
        <ReasonDialog
          title={
            dialog === 'waive'
              ? 'Accept this shortfall as a loss'
              : `Resolve: ${DISCREPANCY_LABEL[d.type]}`
          }
          submit={(note) => api.finance.resolveDiscrepancy(d.id, { action: dialog, note })}
          onClose={() => setDialog(null)}
          danger={dialog === 'waive'}
        />
      )}
    </Row>
  );
}
