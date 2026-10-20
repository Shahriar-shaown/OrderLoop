import type { Product } from '@orderloop/contracts';
import {
  Button,
  FormDialog,
  Row,
  SelectField,
  Stack,
  Text,
  TextField,
  useToast,
  type IconName,
  type Tone,
} from '@orderloop/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { variantLabel } from '../../lib/format';
import { useFormState } from '../../forms/forms';
import { hasReason, REASON_ERROR } from '../../forms/ReasonDialog';
import { invalidateCatalog } from '../../lib/invalidate';
import { newIdempotencyKey, useDebounced, useLocations } from '../../lib/hooks';
import { useApi } from '../../core/runtime';

/** What a stock dialog needs to know about the variant it acts on. */
export interface VariantRef {
  id: string;
  sku: string;
  label: string;
  /** Units on hand and available now, for the "current stock" line. */
  onHand?: number;
  available?: number;
}

/** A product's variant as the stock dialogs name it. */
export const variantRefOf = (
  p: Pick<Product, 'name'>,
  v: Product['variants'][number],
): VariantRef => ({
  id: v.id,
  sku: v.sku,
  label: variantLabel(p.name, v.name),
  onHand: v.stock.onHand,
  available: v.stock.available,
});

export type StockMode = 'receive' | 'adjust' | 'reserve' | 'damage' | 'writeOff' | 'return';
const TITLES: Record<StockMode, string> = {
  receive: 'Receive stock',
  adjust: 'Adjust stock',
  reserve: 'Reserve stock',
  damage: 'Mark as damaged',
  writeOff: 'Write off damaged',
  return: 'Record a return',
};
const ICONS: Record<StockMode, { icon: IconName; tone: Tone }> = {
  receive: { icon: 'box', tone: 'brand' },
  adjust: { icon: 'edit', tone: 'brand' },
  reserve: { icon: 'lock', tone: 'info' },
  damage: { icon: 'alert', tone: 'warning' },
  writeOff: { icon: 'trash', tone: 'error' },
  return: { icon: 'return', tone: 'brand' },
};
/** Modes that must say why: every change to stock is explained in the ledger. */
const NEEDS_REASON: StockMode[] = ['adjust', 'damage', 'writeOff'];
const CONDITIONS = [
  { value: 'RESALEABLE', label: 'Resaleable: goes back on the shelf' },
  { value: 'DAMAGED', label: 'Damaged: goes to the damaged bucket' },
];

/** The - and + buttons inside the quantity field. `signed` lets the count go below 1 (a stock-take correction). */
function Stepper({
  value,
  signed,
  onChange,
}: {
  value: string;
  signed: boolean;
  onChange: (v: string) => void;
}) {
  const n = /^-?\d+$/.test(value.trim()) ? Number(value) : 0;
  const lowest = signed ? -1_000_000 : 1;
  return (
    <Row gap={0}>
      <Button
        variant="ghost"
        size="sm"
        icon="minus"
        accessibilityLabel="Decrease by one"
        onPress={() => onChange(String(Math.max(lowest, n - 1)))}
      />
      <Button
        variant="ghost"
        size="sm"
        icon="plus"
        accessibilityLabel="Increase by one"
        onPress={() => onChange(String(Math.min(1_000_000, n + 1)))}
      />
    </Row>
  );
}

/** Find the item to act on: the variants of one product, or a search of the catalog. */
function ItemPicker({
  product,
  chosenId,
  onChoose,
  error,
}: {
  product?: Product | null | undefined;
  chosenId: string;
  onChoose: (ref: VariantRef | null) => void;
  error?: string | undefined;
}) {
  const api = useApi();
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const results = useQuery({
    queryKey: ['products', 'stock-picker', q],
    queryFn: () => api.products.list({ limit: 20, status: 'ACTIVE', ...(q ? { q } : {}) }),
    enabled: !product,
  });
  const refs = useMemo(() => {
    const products = product ? [product] : (results.data?.items ?? []);
    return products.flatMap((p) =>
      p.variants.filter((v) => !v.archived).map((v) => variantRefOf(p, v)),
    );
  }, [product, results.data]);
  const options = [
    { value: '', label: results.isPending && !product ? 'Loading…' : 'Choose an item' },
    ...refs.map((r) => ({ value: r.id, label: `${r.label} · ${r.sku}` })),
  ];
  return (
    <Stack gap={3}>
      {!product && (
        <TextField
          label="Find a product"
          kind="search"
          leadingIcon="search"
          placeholder="Name or SKU"
          value={search}
          onChangeText={setSearch}
        />
      )}
      <SelectField
        label={product ? 'Variant' : 'Product'}
        required
        options={options}
        value={chosenId}
        onChange={(id) => onChoose(refs.find((r) => r.id === id) ?? null)}
        error={error}
      />
    </Stack>
  );
}

function StockForm({
  mode,
  initial,
  picker,
  product,
  defaultLocationId,
  onClose,
}: {
  mode: StockMode;
  initial: VariantRef | null;
  picker: boolean;
  product?: Product | null | undefined;
  defaultLocationId?: string | undefined;
  onClose: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const locations = useLocations();
  const [variant, setVariant] = useState<VariantRef | null>(initial);
  // One key per variant for this dialog: a double-press replays instead of repeating, a different item gets its own.
  const [keys] = useState(() => new Map<string, string>());
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
    if (!variant) found.variant = 'Choose the item first';
    if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(amount))
      found.amount = 'Enter a whole number';
    else if (mode === 'adjust' ? amount === 0 : amount < 1)
      found.amount =
        mode === 'adjust'
          ? 'Enter a change other than 0 (negative to remove stock)'
          : 'Enter 1 or more';
    else if (Math.abs(amount) > 1_000_000) found.amount = 'That is more than 1,000,000';
    const reason = form.values.reason.trim();
    if (NEEDS_REASON.includes(mode) && !hasReason(reason)) found.reason = REASON_ERROR;
    form.setFormError('');
    if (Object.keys(found).length || !variant) return form.setErrors(found);

    let key = keys.get(variant.id);
    if (!key) keys.set(variant.id, (key = newIdempotencyKey()));
    const idempotencyKey = key;
    const locationId = form.values.locationId || undefined;
    const ok = await form.run(async () => {
      if (mode === 'receive')
        await api.inventory.receive({
          variantId: variant.id,
          quantity: amount,
          ...(locationId ? { locationId } : {}),
          ...(reason ? { reason } : {}),
          idempotencyKey,
        });
      else if (mode === 'adjust')
        await api.inventory.adjust({
          variantId: variant.id,
          delta: amount,
          reason,
          ...(locationId ? { locationId } : {}),
          idempotencyKey,
        });
      else if (mode === 'damage')
        await api.inventory.damage({
          variantId: variant.id,
          quantity: amount,
          reason,
          ...(locationId ? { locationId } : {}),
          idempotencyKey,
        });
      else if (mode === 'writeOff')
        await api.inventory.writeOff({
          variantId: variant.id,
          quantity: amount,
          reason,
          ...(locationId ? { locationId } : {}),
          idempotencyKey,
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
          idempotencyKey,
        });
      } else {
        const reference = form.values.reference.trim();
        await api.reservations.create({
          variantId: variant.id,
          quantity: amount,
          ...(locationId ? { locationId } : {}),
          ...(reference ? { referenceType: 'manual', referenceId: reference } : {}),
          idempotencyKey,
        });
      }
      await invalidateCatalog(queryClient);
    });
    if (ok) {
      toast.success(`${TITLES[mode]}: done for ${variant.sku}`);
      onClose();
    }
  }

  const { icon, tone } = ICONS[mode];
  const needsReason = NEEDS_REASON.includes(mode);
  return (
    <FormDialog
      open
      onClose={onClose}
      title={TITLES[mode]}
      onSubmit={submit}
      submitLabel={TITLES[mode]}
      busy={form.busy}
      error={form.formError}
      danger={mode === 'writeOff'}
      size="sm"
      icon={icon}
      iconTone={tone}
    >
      {picker ? (
        <ItemPicker
          product={product}
          chosenId={variant?.id ?? ''}
          onChoose={setVariant}
          error={form.errors.variant}
        />
      ) : null}
      {variant && (
        <Stack gap={1}>
          <Text>
            <Text weight="bold">{variant.sku}</Text> {variant.label}
          </Text>
          {variant.available !== undefined && (
            <Text variant="small" tone="muted" numeric>
              {`Current stock: ${variant.available} available${
                variant.onHand !== undefined ? ` (${variant.onHand} on hand)` : ''
              }`}
            </Text>
          )}
        </Stack>
      )}
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
        autoFocus={!picker}
        kind="signedInteger"
        value={form.values.amount}
        onChangeText={(t) => form.set('amount', t)}
        trailing={
          <Stepper
            value={form.values.amount}
            signed={mode === 'adjust'}
            onChange={(v) => form.set('amount', v)}
          />
        }
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
          label={needsReason ? 'Reason' : 'Note (optional)'}
          required={needsReason}
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

/**
 * Receive, adjust, reserve, damage, write off or return stock. Mount it with `variant` set to open it for that item, `null` to
 * close. With `picker` it opens without an item and asks which one (of `product`'s variants, or any product).
 */
export function StockDialog({
  mode,
  variant,
  onClose,
  defaultLocationId,
  picker = false,
  product,
}: {
  mode: StockMode;
  variant: VariantRef | null;
  onClose: () => void;
  defaultLocationId?: string;
  /** Open with no item chosen yet. */
  picker?: boolean;
  /** With `picker`: offer only this product's variants. */
  product?: Product | null;
}) {
  if (!variant && !picker) return null;
  // Keyed by item so every opening starts with a fresh form and a fresh idempotency key.
  const only = product && product.variants.filter((v) => !v.archived).length === 1 ? product : null;
  const initial =
    variant ??
    (only
      ? variantRefOf(
          only,
          only.variants.find((v) => !v.archived)!,
        )
      : null);
  return (
    <StockForm
      key={`${mode}:${variant?.id ?? product?.id ?? 'pick'}`}
      mode={mode}
      initial={initial}
      picker={picker && !initial}
      product={product}
      defaultLocationId={defaultLocationId}
      onClose={onClose}
    />
  );
}
