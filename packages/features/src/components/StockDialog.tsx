import { FormDialog, SelectField, Text, TextField, useToast } from '@orderloop/ui';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useFormState } from '../forms';
import { newIdempotencyKey, useLocations } from '../hooks';
import { useApi } from '../runtime';

/** What a stock dialog needs to know about the variant it acts on. */
export interface VariantRef {
  id: string;
  sku: string;
  label: string;
}

export const invalidateStock = (client: QueryClient) =>
  Promise.all(
    ['product', 'products', 'inventory', 'lowStock', 'movements', 'reservations'].map((k) =>
      client.invalidateQueries({ queryKey: [k] }),
    ),
  );

export type StockMode = 'receive' | 'adjust' | 'reserve' | 'damage' | 'writeOff' | 'return';
const TITLES: Record<StockMode, string> = {
  receive: 'Receive stock',
  adjust: 'Adjust stock',
  reserve: 'Reserve stock',
  damage: 'Mark as damaged',
  writeOff: 'Write off damaged',
  return: 'Record a return',
};
/** Modes that must say why: every change to stock is explained in the ledger. */
const NEEDS_REASON: StockMode[] = ['adjust', 'damage', 'writeOff'];
const CONDITIONS = [
  { value: 'RESALEABLE', label: 'Resaleable: goes back on the shelf' },
  { value: 'DAMAGED', label: 'Damaged: goes to the damaged bucket' },
];

function StockForm({
  mode,
  variant,
  defaultLocationId,
  onClose,
}: {
  mode: StockMode;
  variant: VariantRef;
  defaultLocationId?: string | undefined;
  onClose: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const locations = useLocations();
  const [key] = useState(newIdempotencyKey); // fixed for this dialog: a double-press replays instead of repeating
  const form = useFormState({
    locationId: defaultLocationId ?? '',
    amount: '',
    reason: '',
    reference: '',
    condition: 'RESALEABLE',
  });

  const locationOptions = useMemo(
    () => [
      { value: '', label: 'Default location' },
      ...(locations.data ?? [])
        .filter((l) => !l.archived)
        .map((l) => ({ value: l.id, label: `${l.name}${l.isDefault ? ' (default)' : ''}` })),
    ],
    [locations.data],
  );

  async function submit() {
    const raw = form.values.amount.trim();
    const amount = Number(raw);
    const found: Record<string, string> = {};
    if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(amount))
      found.amount = 'Enter a whole number';
    else if (mode === 'adjust' ? amount === 0 : amount < 1)
      found.amount =
        mode === 'adjust'
          ? 'Enter a change other than 0 (negative to remove stock)'
          : 'Enter 1 or more';
    else if (Math.abs(amount) > 1_000_000) found.amount = 'That is more than 1,000,000';
    const reason = form.values.reason.trim();
    if (NEEDS_REASON.includes(mode) && reason.length < 3)
      found.reason = 'Say why (at least 3 characters)';
    form.setFormError('');
    if (Object.keys(found).length) return form.setErrors(found);

    const locationId = form.values.locationId || undefined;
    const ok = await form.run(async () => {
      if (mode === 'receive')
        await api.inventory.receive({
          variantId: variant.id,
          quantity: amount,
          ...(locationId ? { locationId } : {}),
          ...(reason ? { reason } : {}),
          idempotencyKey: key,
        });
      else if (mode === 'adjust')
        await api.inventory.adjust({
          variantId: variant.id,
          delta: amount,
          reason,
          ...(locationId ? { locationId } : {}),
          idempotencyKey: key,
        });
      else if (mode === 'damage')
        await api.inventory.damage({
          variantId: variant.id,
          quantity: amount,
          reason,
          ...(locationId ? { locationId } : {}),
          idempotencyKey: key,
        });
      else if (mode === 'writeOff')
        await api.inventory.writeOff({
          variantId: variant.id,
          quantity: amount,
          reason,
          ...(locationId ? { locationId } : {}),
          idempotencyKey: key,
        });
      else if (mode === 'return') {
        const reference = form.values.reference.trim();
        await api.inventory.return({
          variantId: variant.id,
          quantity: amount,
          condition: form.values.condition as 'RESALEABLE' | 'DAMAGED',
          ...(reason ? { reason } : {}),
          ...(locationId ? { locationId } : {}),
          ...(reference ? { referenceType: 'return', referenceId: reference } : {}),
          idempotencyKey: key,
        });
      } else {
        const reference = form.values.reference.trim();
        await api.reservations.create({
          variantId: variant.id,
          quantity: amount,
          ...(locationId ? { locationId } : {}),
          ...(reference ? { referenceType: 'manual', referenceId: reference } : {}),
          idempotencyKey: key,
        });
      }
      await invalidateStock(queryClient);
    });
    if (ok) {
      toast.success(`${TITLES[mode]}: done for ${variant.sku}`);
      onClose();
    }
  }

  return (
    <FormDialog
      open
      onClose={onClose}
      title={TITLES[mode]}
      onSubmit={submit}
      submitLabel={TITLES[mode]}
      busy={form.busy}
      error={form.formError}
      size="sm"
    >
      <Text>
        <Text weight="bold">{variant.sku}</Text> {variant.label}
      </Text>
      <SelectField
        label="Location"
        options={locationOptions}
        value={form.values.locationId}
        onChange={(v) => form.set('locationId', v)}
        error={form.errors.locationId}
      />
      <TextField
        label={mode === 'adjust' ? 'Change in stock' : 'Quantity'}
        required
        autoFocus
        kind="signedInteger"
        value={form.values.amount}
        onChangeText={(t) => form.set('amount', t)}
        error={form.errors.amount ?? form.errors.quantity ?? form.errors.delta}
        hint={
          mode === 'adjust'
            ? 'Positive adds, negative removes, for example -3 for three damaged items.'
            : undefined
        }
      />
      {mode === 'return' && (
        <SelectField
          label="Condition"
          options={CONDITIONS}
          value={form.values.condition}
          onChange={(v) => form.set('condition', v)}
          error={form.errors.condition}
        />
      )}
      {mode !== 'reserve' && (
        <TextField
          label={NEEDS_REASON.includes(mode) ? 'Reason' : 'Note (optional)'}
          required={NEEDS_REASON.includes(mode)}
          placeholder={
            mode === 'adjust'
              ? 'Stock take, lost…'
              : mode === 'damage'
                ? 'Broken, water damage, expired…'
                : mode === 'writeOff'
                  ? 'Thrown away, returned to supplier…'
                  : 'Supplier delivery…'
          }
          {...form.field('reason')}
        />
      )}
      {(mode === 'reserve' || mode === 'return') && (
        <TextField
          label="Reference (optional)"
          placeholder={mode === 'return' ? 'Return or order number' : 'Order or basket number'}
          value={form.values.reference}
          onChangeText={(t) => form.set('reference', t)}
          error={form.errors.referenceId}
        />
      )}
    </FormDialog>
  );
}

/** Receive, adjust or reserve stock for one variant. Mount it with `variant` set to open it, `null` to close. */
export function StockDialog({
  mode,
  variant,
  onClose,
  defaultLocationId,
}: {
  mode: StockMode;
  variant: VariantRef | null;
  onClose: () => void;
  defaultLocationId?: string;
}) {
  // Keyed by variant so every opening starts with a fresh form and a fresh idempotency key.
  return variant ? (
    <StockForm
      key={`${mode}:${variant.id}`}
      mode={mode}
      variant={variant}
      defaultLocationId={defaultLocationId}
      onClose={onClose}
    />
  ) : null;
}
