import { ApiError } from '@orderloop/api-client';
import {
  CreateOrderBody,
  normalizeBdPhone,
  UpdateOrderBody,
  type CustomerDetail,
  type OrderDetail,
  type OrderSource,
  type SocialDraft,
} from '@orderloop/contracts';
import {
  calculateOrderTotals,
  editScope,
  OrderTotalsError,
  formatBdPhone,
} from '@orderloop/domain';
import {
  Alert,
  Button,
  FieldGrid,
  Form,
  Link,
  Section,
  SelectField,
  Split,
  Stack,
  StickyActions,
  Text,
  TextField,
  useBreakpoint,
  useNavigation,
  useToast,
} from '@orderloop/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { View } from 'react-native';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { validate, type FormErrors } from '../../forms/errors';
import { useFormState } from '../../forms/forms';
import { useIdempotencyKey } from '../../forms/useIdempotencyKey';
import { useDebounced } from '../../lib/hooks';
import { CHECK_THIS, invalidateDrafts } from '../../lib/meta';
import {
  draftFormValues,
  draftLines,
  draftPatch,
  draftPending,
  uncertainFields,
  type PendingItem,
} from '../../lib/socialDraftForm';
import { parsePrice, priceToInput } from '../../lib/money';
import { DIVISION_OPTIONS, invalidateOrders, SOURCE_OPTIONS } from '../../lib/orders';
import { useApi } from '../../core/runtime';
import { FormError } from '../../forms/FormError';
import { DraftDuplicates } from '../meta/DraftDuplicates';
import { DraftItemsPanel } from '../meta/DraftItemsPanel';
import { OrderCustomerSection } from './OrderCustomerSection';
import { first, lineFromVariant, OrderLines, stockIssues, type Line } from './OrderLines';
import { OrderSummaryCard, type ChecklistItem } from './OrderSummaryCard';

const EMPTY = {
  phone: '',
  customerName: '',
  recipientName: '',
  addrPhone: '',
  line1: '',
  area: '',
  district: '',
  division: 'Dhaka',
  postalCode: '',
  discount: '',
  delivery: '',
  advance: '',
  source: 'other',
  sourceReference: '',
  notes: '',
};

/** An amount box: blank means "none"; anything else must be a valid taka amount. Returns undefined for blank, null for invalid. */
const amount = (text: string): number | undefined | null =>
  text.trim() === '' ? undefined : parsePrice(text);

/**
 * The order form, used to make an order, to edit one, and to review a draft from a customer's message (the same fields,
 * rules and totals; Confirm goes to the draft's own endpoint, which creates the order through the same code): four numbered cards (customer, delivery address, products,
 * payment and source) and a sticky summary. The summary uses the same totals function as the server and is labelled as an
 * estimate: the server's figures win. One idempotency key per form, so pressing Confirm twice, or retrying after a dropped
 * connection, can only ever make one order.
 */
export function OrderForm({
  order,
  customerId,
  draft,
  extraActions,
}: {
  order?: OrderDetail;
  customerId?: string;
  /** Review a draft made from a customer's message: the form starts from it, Confirm creates the order from it. */
  draft?: SocialDraft;
  /** More buttons under the form's own (the draft screen's Dismiss). */
  extraActions?: ReactNode;
}) {
  const api = useApi();
  const navigation = useNavigation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { isMobile } = useBreakpoint();
  const editing = order !== undefined;
  const scope = order ? editScope(order.status) : 'full';
  const { key } = useIdempotencyKey();

  const form = useFormState(
    draft
      ? draftFormValues(draft)
      : order
        ? {
            ...EMPTY,
            phone: order.customer.phone,
            customerName: order.customer.name,
            recipientName: order.shipping.recipientName,
            addrPhone: formatBdPhone(order.shipping.phone),
            line1: order.shipping.line1,
            area: order.shipping.area,
            district: order.shipping.district,
            division: order.shipping.division,
            postalCode: order.shipping.postalCode ?? '',
            discount: order.discountMinor ? priceToInput(order.discountMinor) : '',
            delivery: order.deliveryChargeMinor ? priceToInput(order.deliveryChargeMinor) : '',
            advance: order.advancePaidMinor ? priceToInput(order.advancePaidMinor) : '',
            source: order.source,
            sourceReference: order.sourceReference ?? '',
            notes: order.notes ?? '',
          }
        : EMPTY,
    {
      phone: ['customer.phone', 'customerId', 'customer'],
      customerName: ['customer.name'],
      addrPhone: ['address.phone'],
      discount: ['discountMinor'],
      delivery: ['deliveryChargeMinor'],
      advance: ['advancePaidMinor'],
    },
  );
  const [lines, setLines] = useState<Line[]>(() =>
    draft
      ? draftLines(draft)
      : (order?.items ?? []).map((i) => ({
          variantId: i.variantId,
          sku: i.sku,
          label: i.variantName ? `${i.productName} — ${i.variantName}` : i.productName,
          catalogPriceMinor: i.unitPriceMinor,
          available: null,
          reorderPoint: 0,
          costMinor: null,
          quantity: String(i.quantity),
          unitPrice: priceToInput(i.unitPriceMinor),
          discount: i.discountMinor ? priceToInput(i.discountMinor) : '',
        })),
  );

  // ---- customer (a new order only) -----------------------------------------------------------------------------------
  const [pickedId, setPickedId] = useState<string | null>(customerId ?? null);
  const [mode, setMode] = useState<'search' | 'new'>(draft ? 'new' : 'search');
  // A draft's items that no product was matched to: a person picks the product before the order can be made.
  const [pending, setPending] = useState<PendingItem[]>(() => (draft ? draftPending(draft) : []));
  const [acknowledged, setAcknowledged] = useState(false);
  const suspect = useMemo(() => (draft ? uncertainFields(draft) : new Set<string>()), [draft]);
  const startValues = useMemo(() => (draft ? draftFormValues(draft) : null), [draft]);
  /** "Check this" while a field still holds what was read from the chat with low confidence. */
  const checkHint = (key: string, name: keyof ReturnType<typeof draftFormValues>) =>
    suspect.has(key) && startValues && form.values[name] === startValues[name]
      ? CHECK_THIS
      : undefined;
  const picked = useQuery({
    queryKey: ['customer', pickedId],
    enabled: !editing && !!pickedId,
    queryFn: () => api.customers.get(pickedId!),
  });
  const { set } = form;
  function fillAddress(a: CustomerDetail['addresses'][number]) {
    set('recipientName', a.recipientName);
    set('addrPhone', formatBdPhone(a.phone));
    set('line1', a.line1);
    set('area', a.area);
    set('district', a.district);
    set('division', a.division);
    set('postalCode', a.postalCode ?? '');
  }
  useEffect(() => {
    const c = picked.data;
    if (!c) return;
    set('phone', c.phone);
    set('customerName', c.name);
    const a = c.addresses.find((x) => x.isDefault) ?? c.addresses[0];
    // A draft's address is what the customer just wrote: it stays, whatever address is saved for them.
    if (a && !draft) fillAddress(a);
  }, [picked.data?.id]);

  // A phone number typed for a new customer that is already on file is that customer: pick them instead of adding twice.
  const normalized = normalizeBdPhone(form.values.phone);
  const lookupPhone = useDebounced(normalized);
  const byPhone = useQuery({
    queryKey: ['customers', 'byPhone', lookupPhone],
    enabled: !editing && mode === 'new' && !pickedId && lookupPhone !== null,
    queryFn: async () => {
      const found = await api.customers.list({ q: lookupPhone!, limit: 5 });
      return found.items.find((c) => c.phone === lookupPhone) ?? null;
    },
  });
  useEffect(() => {
    if (byPhone.data) setPickedId(byPhone.data.id);
  }, [byPhone.data?.id]);

  const existing = editing ? null : (picked.data ?? null);
  const addressOptions = useMemo(
    () => [
      { value: '', label: 'Choose a saved address…' },
      ...(existing?.addresses ?? []).map((a) => ({
        value: a.id,
        label: `${a.label ? `${a.label}: ` : ''}${a.line1}, ${a.district}${a.isDefault ? ' (default)' : ''}`,
      })),
    ],
    [existing],
  );

  // ---- items and the estimate ----------------------------------------------------------------------------------------
  const parsedLines = lines.map((l) => {
    const quantity = Number(l.quantity);
    const price = l.unitPrice.trim() === '' ? l.catalogPriceMinor : parsePrice(l.unitPrice);
    const disc = amount(l.discount);
    return { quantity, unitPriceMinor: price, discountMinor: disc };
  });
  const estimate = useMemo(() => {
    const d = amount(form.values.discount);
    const del = amount(form.values.delivery);
    const adv = amount(form.values.advance);
    if (
      lines.length === 0 ||
      parsedLines.some((l) => l.unitPriceMinor === null || l.discountMinor === null) ||
      d === null ||
      del === null ||
      adv === null
    )
      return null;
    try {
      return calculateOrderTotals({
        lines: parsedLines.map((l) => ({
          quantity: l.quantity,
          unitPriceMinor: l.unitPriceMinor!,
          discountMinor: l.discountMinor ?? 0,
        })),
        discountMinor: d ?? 0,
        deliveryChargeMinor: del ?? 0,
        advancePaidMinor: adv ?? 0,
      });
    } catch (error) {
      if (error instanceof OrderTotalsError) return { problem: error.message } as const;
      throw error;
    }
  }, [lines, form.values.discount, form.values.delivery, form.values.advance]);
  const okTotals = estimate && !('problem' in estimate) ? estimate : null;
  const productCost =
    lines.length > 0 && lines.every((l) => l.costMinor !== null)
      ? lines.reduce((n, l) => n + l.costMinor! * (Number(l.quantity) || 0), 0)
      : null;

  // ---- possible repeats ----------------------------------------------------------------------------------------------
  const variantKey = lines.map((l) => l.variantId).join(',');
  const dupPhone = useDebounced(normalized);
  const duplicates = useQuery({
    queryKey: ['orderDuplicates', 'form', dupPhone, variantKey, order?.id],
    enabled: dupPhone !== null && !draft,
    queryFn: () =>
      api.orders.checkDuplicates({
        phone: dupPhone!,
        variantIds: lines.map((l) => l.variantId),
        ...(order ? { excludeOrderId: order.id } : {}),
      }),
  });

  const patchLine = (i: number, patch: Partial<Line>) => {
    setLines((all) => all.map((l, j) => (j === i ? { ...l, ...patch } : l)));
    form.clearFor(`items.${i}`, `lines.${i}`);
  };

  // ---- submit --------------------------------------------------------------------------------------------------------
  function buildItems(): { items: object[]; errors: FormErrors } {
    const errors: FormErrors = {};
    const items = lines.map((l, i) => {
      const p = parsedLines[i]!;
      if (p.unitPriceMinor === null)
        errors[`items.${i}.unitPriceMinor`] = 'Enter an amount like 850 or 850.50';
      if (p.discountMinor === null)
        errors[`items.${i}.discountMinor`] = 'Enter an amount like 50 or 50.50';
      return {
        variantId: l.variantId,
        quantity: p.quantity,
        ...(l.unitPrice.trim() !== '' && p.unitPriceMinor !== null
          ? { unitPriceMinor: p.unitPriceMinor }
          : {}),
        ...(p.discountMinor ? { discountMinor: p.discountMinor } : {}),
      };
    });
    return { items, errors };
  }

  /** Someone else closed the draft meanwhile: reload it (the screen turns read-only) and still show the error. */
  const closedDraft = async (error: unknown): Promise<never> => {
    if (error instanceof ApiError && error.code === 'draft_closed')
      await invalidateDrafts(queryClient);
    throw error;
  };

  async function submit(confirm: boolean) {
    const v = form.values;
    const { items, errors: lineErrors } = buildItems();
    const money: FormErrors = {};
    const d = amount(v.discount);
    const del = amount(v.delivery);
    const adv = amount(v.advance);
    if (d === null) money.discountMinor = 'Enter an amount like 100 or 100.50';
    if (del === null) money.deliveryChargeMinor = 'Enter an amount like 60';
    if (adv === null) money.advancePaidMinor = 'Enter an amount like 500';
    const adjustments = {
      ...(d ? { discountMinor: d } : {}),
      ...(del ? { deliveryChargeMinor: del } : {}),
      ...(adv ? { advancePaidMinor: adv } : {}),
    };
    const address = {
      recipientName: v.recipientName,
      phone: v.addrPhone || v.phone,
      line1: v.line1,
      area: v.area,
      district: v.district,
      division: v.division,
      ...(v.postalCode.trim() ? { postalCode: v.postalCode.trim() } : {}),
    };
    const extras = {
      source: v.source as OrderSource,
      sourceReference: v.sourceReference.trim() || null,
      notes: v.notes.trim() || null,
    };

    form.setFormError('');
    if (editing && order) {
      const payload: Record<string, unknown> = { ifVersion: order.version };
      if (scope === 'full' || scope === 'contact')
        Object.assign(payload, {
          address,
          source: extras.source,
          sourceReference: extras.sourceReference,
        });
      payload.notes = extras.notes;
      if (scope === 'full')
        Object.assign(payload, {
          items,
          discountMinor: d ?? 0,
          deliveryChargeMinor: del ?? 0,
          advancePaidMinor: adv ?? 0,
        });
      const checked = validate(UpdateOrderBody, payload);
      const local = { ...lineErrors, ...money };
      if (Object.keys(local).length || !checked.data)
        return form.setErrors({ ...(checked.errors ?? {}), ...local });
      const body = checked.data;
      const ok = await form.run(async () => {
        await api.orders.update(order.id, body);
        await invalidateOrders(queryClient);
      });
      if (ok) {
        toast.success('Order saved');
        navigation.replace(`/orders/${order.id}`);
      }
      return;
    }

    const payload = {
      ...(pickedId
        ? { customerId: pickedId }
        : { customer: { name: v.customerName, phone: v.phone } }),
      address,
      items,
      ...adjustments,
      ...extras,
      confirm,
      idempotencyKey: key,
    };
    // The schema's own customer checks only run once everything else is valid, so say it here too.
    const customerErrors: FormErrors = {};
    if (!pickedId && mode === 'search')
      customerErrors.customer = 'Choose a customer or enter their details';
    if (!pickedId && mode === 'new') {
      if (v.customerName.trim().length < 2)
        customerErrors['customer.name'] = 'Enter the customer’s name';
      if (!normalizeBdPhone(v.phone))
        customerErrors['customer.phone'] = 'Enter a Bangladeshi mobile number like 01712-345678';
    }
    if (pending.length > 0)
      customerErrors.items =
        'Pick the product for every item the customer asked for, or remove it.';
    const checked = validate(CreateOrderBody, payload);
    const local = { ...lineErrors, ...money, ...customerErrors };
    if (Object.keys(local).length || !checked.data)
      return form.setErrors({ ...(checked.errors ?? {}), ...local });
    const body = checked.data;
    let createdId = '';
    const ok = await form.run(async () => {
      const created = draft
        ? (await api.socialDrafts.confirm(draft.id, body as never).catch(closedDraft)).order
        : await api.orders.create(body as never);
      createdId = created.id;
      await Promise.all([invalidateOrders(queryClient), invalidateDrafts(queryClient)]);
      toast.success(`Order #${created.orderNumber} created`);
    });
    if (ok) navigation.replace(`/orders/${createdId}`);
  }

  /** Keep what the person corrected on the draft (it survives new messages from the customer). */
  async function saveDraft() {
    if (!draft) return;
    const patch = draftPatch(
      draft,
      form.values as ReturnType<typeof draftFormValues>,
      lines,
      pending,
    );
    if (Object.keys(patch).length === 0) return toast.success('Nothing new to save');
    const ok = await form.run(async () => {
      const saved = await api.socialDrafts.update(draft.id, patch).catch(closedDraft);
      queryClient.setQueryData(['socialDraft', draft.id], saved);
      await invalidateDrafts(queryClient);
    });
    if (ok) toast.success('Draft saved');
  }

  const e = form.errors;
  const showItems = scope === 'full';
  const showAddress = scope === 'full' || scope === 'contact';
  const field = (name: keyof typeof EMPTY) => form.field(name);

  const issues = stockIssues(lines);
  const short = issues.filter((x) => x.short).length;
  const v = form.values;
  const checklist: ChecklistItem[] | undefined = editing
    ? undefined
    : [
        { label: 'Customer selected', ok: !!pickedId || (!!v.customerName.trim() && !!normalized) },
        {
          label: 'Address complete',
          ok: [v.recipientName, v.line1, v.area, v.district].every((t) => t.trim() !== ''),
        },
        lines.length === 0
          ? { label: 'Add at least one product', ok: false }
          : short > 0
            ? { label: `${short} product${short === 1 ? '' : 's'} short of stock`, ok: false }
            : {
                label: `${lines.length} product${lines.length === 1 ? '' : 's'} in stock`,
                ok: true,
              },
      ];

  const needsAcknowledgement = !!draft && draft.duplicates.length > 0 && !acknowledged;
  const actions = draft ? (
    <Stack gap={2}>
      <Button
        loading={form.busy}
        disabled={needsAcknowledgement}
        fullWidth
        onPress={() => submit(true)}
      >
        Confirm order
      </Button>
      {needsAcknowledgement && (
        <Text variant="caption" tone="muted">
          Tick “This is a different order” above to confirm.
        </Text>
      )}
      <Button variant="secondary" type="submit" loading={form.busy} fullWidth>
        Save draft
      </Button>
      {extraActions}
      <Text variant="caption" tone="muted">
        Confirming creates the order and holds its stock. Nothing is ordered until you confirm.
      </Text>
    </Stack>
  ) : editing ? (
    <Stack gap={2}>
      <Button type="submit" loading={form.busy} fullWidth>
        Save changes
      </Button>
      <Button variant="secondary" href={`/orders/${order!.id}`} fullWidth>
        Cancel
      </Button>
    </Stack>
  ) : (
    <Stack gap={2}>
      <Button loading={form.busy} fullWidth onPress={() => submit(true)}>
        Confirm order
      </Button>
      <Button variant="secondary" type="submit" loading={form.busy} fullWidth>
        Save as draft
      </Button>
      <Text variant="caption" tone="muted">
        Confirming holds the stock for this order. A draft holds nothing until you confirm.
      </Text>
    </Stack>
  );

  const main = (
    <>
      <FormError message={form.formError} />

      <OrderCustomerSection
        fixed={editing ? { name: order!.customer.name, phone: order!.customer.phone } : undefined}
        picked={editing ? null : (picked.data ?? null)}
        loading={!!pickedId && picked.isPending && !editing}
        mode={mode}
        onMode={setMode}
        onPick={(id) => {
          setPickedId(id);
          form.clearFor('phone', 'customerName');
        }}
        onClear={() => {
          setPickedId(null);
          setMode('search');
          set('phone', '');
          set('customerName', '');
        }}
        phone={field('phone')}
        name={field('customerName')}
        phoneError={first(e, 'customer.phone', 'customerId', 'phone')}
        nameError={first(e, 'customer.name')}
        phoneHint={checkHint('phone', 'phone')}
        nameHint={checkHint('customerName', 'customerName')}
      />
      {!editing && !pickedId && mode === 'search' && first(e, 'customer') && (
        <Text variant="small" tone="danger" role="alert">
          {first(e, 'customer')}
        </Text>
      )}

      {draft && draft.duplicates.length > 0 && (
        <DraftDuplicates
          duplicates={draft.duplicates}
          acknowledged={acknowledged}
          onAcknowledge={setAcknowledged}
        />
      )}
      {!draft && duplicates.data && duplicates.data.length > 0 && (
        <Alert tone="warning" title="These recent orders look similar">
          <Stack gap={2}>
            {duplicates.data.map((d) => (
              <Stack key={d.orderId} gap={1}>
                <Link href={`/orders/${d.orderId}`}>Order #{d.orderNumber}</Link>
                <Text variant="caption">{d.reasons.join(' · ')}</Text>
              </Stack>
            ))}
            <Text variant="caption" tone="muted">
              This is only a hint. You can still save this order.
            </Text>
          </Stack>
        </Alert>
      )}

      {showAddress && (
        <Section title="2 · Delivery address">
          {existing && existing.addresses.length > 0 && (
            <SelectField
              label="Saved addresses"
              options={addressOptions}
              value=""
              onChange={(id) => {
                const a = existing.addresses.find((x) => x.id === id);
                if (a) fillAddress(a);
              }}
            />
          )}
          <FieldGrid>
            <TextField
              label="Recipient name"
              required
              {...field('recipientName')}
              error={first(e, 'address.recipientName')}
            />
            <TextField
              label="Recipient phone"
              keyboardType="phone-pad"
              hint="Leave blank to use the customer's number."
              {...field('addrPhone')}
              error={first(e, 'address.phone')}
            />
          </FieldGrid>
          <TextField
            label="Address"
            required
            placeholder="House / flat, road, village"
            hint={checkHint('address', 'line1') ?? 'Used on the courier label.'}
            {...field('line1')}
            error={first(e, 'address.line1')}
          />
          <FieldGrid>
            <TextField
              label="Thana / upazila"
              required
              hint={checkHint('area', 'area') ?? 'Required for courier routing.'}
              {...field('area')}
              error={first(e, 'address.area')}
            />
            <TextField
              label="District"
              required
              {...(checkHint('district', 'district')
                ? { hint: checkHint('district', 'district')! }
                : {})}
              {...field('district')}
              error={first(e, 'address.district')}
            />
            <SelectField
              label="Division"
              options={DIVISION_OPTIONS}
              value={form.values.division}
              onChange={(x) => form.set('division', x)}
              error={first(e, 'address.division')}
            />
            <TextField
              label="Postal code"
              keyboardType="number-pad"
              {...(checkHint('postalCode', 'postalCode')
                ? { hint: checkHint('postalCode', 'postalCode')! }
                : {})}
              {...field('postalCode')}
              error={first(e, 'address.postalCode')}
            />
          </FieldGrid>
        </Section>
      )}

      {showItems && (
        <Section
          title="3 · Products"
          description="Prices come from the catalog. Change one only for a negotiated price."
        >
          {draft && (
            <DraftItemsPanel
              pending={pending}
              onPick={(index, variant) => {
                const item = pending[index]!;
                setPending((all) => all.filter((_, j) => j !== index));
                setLines((all) =>
                  all.some((l) => l.variantId === variant.id)
                    ? all.map((l) =>
                        l.variantId === variant.id
                          ? { ...l, quantity: String(Number(l.quantity) + item.quantity) }
                          : l,
                      )
                    : [
                        ...all,
                        {
                          ...lineFromVariant(variant),
                          quantity: String(item.quantity),
                          fromChat: { text: item.text, check: false },
                        },
                      ],
                );
                form.clearFor('items', 'lines');
              }}
              onRemove={(index) => setPending((all) => all.filter((_, j) => j !== index))}
            />
          )}
          <OrderLines
            lines={lines}
            lineTotals={okTotals?.lineTotalsMinor}
            errors={e}
            onAdd={(variant) => {
              setLines((all) =>
                all.some((l) => l.variantId === variant.id)
                  ? all
                  : [...all, lineFromVariant(variant)],
              );
              form.clearFor('items', 'lines');
            }}
            onPatch={patchLine}
            onRemove={(i) => {
              setLines((all) => all.filter((_, j) => j !== i));
              form.clearFor('items', 'lines');
            }}
          />
        </Section>
      )}

      {(scope === 'full' || scope === 'contact' || scope === 'notes') && (
        <Section
          title="4 · Payment & source"
          description={
            showItems
              ? 'Cash on delivery is the total minus the advance. It is worked out for you.'
              : undefined
          }
        >
          {showItems && (
            <FieldGrid minWidth={170}>
              <TextField
                label="Advance paid (৳)"
                kind="decimal"
                {...field('advance')}
                error={first(e, 'advancePaidMinor')}
              />
              <TextField
                label="Discount (৳)"
                kind="decimal"
                {...field('discount')}
                error={first(e, 'discountMinor')}
              />
              <TextField
                label="Delivery charge (৳)"
                kind="decimal"
                {...field('delivery')}
                error={first(e, 'deliveryChargeMinor')}
              />
            </FieldGrid>
          )}
          <FieldGrid>
            {scope !== 'notes' && (
              <SelectField
                label="Where did this order come from?"
                options={SOURCE_OPTIONS}
                value={form.values.source}
                onChange={(x) => form.set('source', x)}
              />
            )}
            {scope !== 'notes' && (
              <TextField
                label="Source reference"
                hint="A post or chat link, a campaign, who took the call."
                {...field('sourceReference')}
                error={first(e, 'sourceReference')}
              />
            )}
          </FieldGrid>
          <TextField
            label="Internal notes"
            multiline
            hint={checkHint('note', 'notes') ?? 'Only your team can see this.'}
            {...field('notes')}
            error={first(e, 'notes')}
          />
        </Section>
      )}
    </>
  );

  const aside = (
    <OrderSummaryCard
      lines={lines.map((l, i) => ({
        label: l.label,
        quantity: Number(l.quantity) || 0,
        totalMinor: okTotals?.lineTotalsMinor[i],
      }))}
      totals={estimate}
      productCostMinor={productCost}
      {...(checklist ? { checklist } : {})}
      actions={isMobile ? undefined : actions}
    />
  );

  return (
    <Form onSubmit={() => (draft ? saveDraft() : submit(false))} gap={5}>
      <Split sticky asideWidth={360} main={<>{main}</>} aside={aside} />
      {isMobile && (
        <StickyActions>
          <View style={{ width: '100%', minWidth: 0 }}>{actions}</View>
        </StickyActions>
      )}
    </Form>
  );
}
