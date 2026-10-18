import {
  CreateOrderBody,
  normalizeBdPhone,
  UpdateOrderBody,
  type CustomerDetail,
  type OrderDetail,
  type OrderSource,
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
  KeyValueList,
  Link,
  Row,
  Section,
  SelectField,
  Stack,
  Text,
  TextField,
  useNavigation,
  useToast,
} from '@orderloop/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { validate, type FormErrors } from '../errors';
import { useFormState } from '../forms';
import { newIdempotencyKey, useDebounced } from '../hooks';
import { formatPrice, parsePrice, priceToInput } from '../money';
import { DIVISION_OPTIONS, invalidateOrders, SOURCE_OPTIONS } from '../orders';
import { useApi } from '../runtime';
import { FormError } from './FormError';
import { VariantPicker, type PickedVariant } from './VariantPicker';

interface Line {
  variantId: string;
  sku: string;
  label: string;
  catalogPriceMinor: number;
  available: number | null;
  quantity: string;
  unitPrice: string;
  discount: string;
}

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

const first = (errors: FormErrors, ...paths: string[]): string | undefined =>
  paths.map((p) => errors[p]).find(Boolean);

/** An amount box: blank means "none"; anything else must be a valid taka amount. Returns undefined for blank, null for invalid. */
const amount = (text: string): number | undefined | null =>
  text.trim() === '' ? undefined : parsePrice(text);

/**
 * The order form, used to make an order and to edit one. Customer lookup, saved addresses, a catalog search for items,
 * a live estimate of the totals (the same functions the server uses, labelled as an estimate: the server's figures win),
 * a warning about possible repeat orders, and one idempotency key per form so pressing Create twice, or retrying after a
 * dropped connection, can only ever make one order.
 */
export function OrderForm({ order, customerId }: { order?: OrderDetail; customerId?: string }) {
  const api = useApi();
  const navigation = useNavigation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const editing = order !== undefined;
  const scope = order ? editScope(order.status) : 'full';
  const [key] = useState(newIdempotencyKey);

  const form = useFormState(
    order
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
  );
  const [lines, setLines] = useState<Line[]>(() =>
    (order?.items ?? []).map((i) => ({
      variantId: i.variantId,
      sku: i.sku,
      label: i.variantName ? `${i.productName} — ${i.variantName}` : i.productName,
      catalogPriceMinor: i.unitPriceMinor,
      available: null,
      quantity: String(i.quantity),
      unitPrice: priceToInput(i.unitPriceMinor),
      discount: i.discountMinor ? priceToInput(i.discountMinor) : '',
    })),
  );
  const [pickedCustomer, setPickedCustomer] = useState<string | null>(customerId ?? null);

  // ---- customer lookup (a new order only) ----------------------------------------------------------------------------
  const normalized = normalizeBdPhone(form.values.phone);
  const lookupPhone = useDebounced(normalized);
  const byPhone = useQuery({
    queryKey: ['customers', 'byPhone', lookupPhone],
    enabled: !editing && lookupPhone !== null,
    queryFn: async (): Promise<CustomerDetail | null> => {
      const found = await api.customers.list({ q: lookupPhone!, limit: 5 });
      const match = found.items.find((c) => c.phone === lookupPhone);
      return match ? api.customers.get(match.id) : null;
    },
  });
  const preset = useQuery({
    queryKey: ['customer', customerId],
    enabled: !editing && !!customerId,
    queryFn: () => api.customers.get(customerId!),
  });
  const existing = editing ? null : (byPhone.data ?? (customerId ? preset.data : null) ?? null);
  const { set } = form;
  useEffect(() => {
    if (!preset.data) return;
    set('phone', preset.data.phone);
    set('customerName', preset.data.name);
    const a = preset.data.addresses.find((x) => x.isDefault) ?? preset.data.addresses[0];
    if (a) fillAddress(a);
  }, [preset.data]);
  useEffect(() => {
    if (existing && !editing) {
      setPickedCustomer(existing.id);
      if (!form.values.customerName) set('customerName', existing.name);
    } else if (!customerId) setPickedCustomer(null);
  }, [existing?.id]);

  function fillAddress(a: CustomerDetail['addresses'][number]) {
    set('recipientName', a.recipientName);
    set('addrPhone', formatBdPhone(a.phone));
    set('line1', a.line1);
    set('area', a.area);
    set('district', a.district);
    set('division', a.division);
    set('postalCode', a.postalCode ?? '');
  }
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

  // ---- possible repeats ----------------------------------------------------------------------------------------------
  const variantKey = lines.map((l) => l.variantId).join(',');
  const dupPhone = useDebounced(normalized);
  const duplicates = useQuery({
    queryKey: ['orderDuplicates', 'form', dupPhone, variantKey, order?.id],
    enabled: dupPhone !== null,
    queryFn: () =>
      api.orders.checkDuplicates({
        phone: dupPhone!,
        variantIds: lines.map((l) => l.variantId),
        ...(order ? { excludeOrderId: order.id } : {}),
      }),
  });

  function addLine(v: PickedVariant) {
    setLines((all) =>
      all.some((l) => l.variantId === v.id)
        ? all
        : [
            ...all,
            {
              variantId: v.id,
              sku: v.sku,
              label: v.label,
              catalogPriceMinor: v.priceMinor,
              available: v.available,
              quantity: '1',
              unitPrice: '',
              discount: '',
            },
          ],
    );
  }
  const patchLine = (i: number, patch: Partial<Line>) =>
    setLines((all) => all.map((l, j) => (j === i ? { ...l, ...patch } : l)));

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
        navigation.push(`/orders/${order.id}`);
      }
      return;
    }

    const payload = {
      ...(pickedCustomer
        ? { customerId: pickedCustomer }
        : { customer: { name: v.customerName, phone: v.phone } }),
      address,
      items,
      ...adjustments,
      ...extras,
      confirm,
      idempotencyKey: key,
    };
    const checked = validate(CreateOrderBody, payload);
    const local = { ...lineErrors, ...money };
    if (Object.keys(local).length || !checked.data)
      return form.setErrors({ ...(checked.errors ?? {}), ...local });
    const body = checked.data;
    let createdId = '';
    const ok = await form.run(async () => {
      const created = await api.orders.create(body as never);
      createdId = created.id;
      await invalidateOrders(queryClient);
      toast.success(`Order #${created.orderNumber} created`);
    });
    if (ok) navigation.push(`/orders/${createdId}`);
  }

  const e = form.errors;
  const showItems = scope === 'full';
  const showAddress = scope === 'full' || scope === 'contact';
  const field = (name: keyof typeof EMPTY) => form.field(name);

  return (
    <Form onSubmit={() => submit(false)} gap={5}>
      <FormError message={form.formError} />

      {!editing && (
        <Section
          title="Customer"
          description="A phone number already on file is the same customer: nobody is added twice."
        >
          <FieldGrid>
            <TextField
              label="Phone"
              required
              kind="text"
              keyboardType="phone-pad"
              placeholder="01712-345678"
              {...field('phone')}
              error={first(e, 'customer.phone', 'customerId', 'phone')}
            />
            {!existing && (
              <TextField
                label="Customer name"
                required
                {...field('customerName')}
                error={first(e, 'customer.name')}
              />
            )}
          </FieldGrid>
          {existing && (
            <Alert tone="info" title={`Existing customer: ${existing.name}`}>
              <Stack gap={1}>
                <Text>
                  {existing.stats.ordersCount} order{existing.stats.ordersCount === 1 ? '' : 's'}:{' '}
                  {existing.stats.deliveredCount} delivered, {existing.stats.returnedCount}{' '}
                  returned, {existing.stats.cancelledCount} cancelled.
                </Text>
                <Link href={`/customers/${existing.id}`}>Open customer</Link>
              </Stack>
            </Alert>
          )}
        </Section>
      )}
      {editing && (
        <Section title="Customer">
          <KeyValueList
            items={[
              { label: 'Name', value: order!.customer.name },
              { label: 'Phone', value: formatBdPhone(order!.customer.phone) },
            ]}
          />
        </Section>
      )}

      {duplicates.data && duplicates.data.length > 0 && (
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
        <Section title="Delivery address">
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
            placeholder="House, road, village"
            {...field('line1')}
            error={first(e, 'address.line1')}
          />
          <FieldGrid>
            <TextField
              label="Thana / upazila"
              required
              {...field('area')}
              error={first(e, 'address.area')}
            />
            <TextField
              label="District"
              required
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
              {...field('postalCode')}
              error={first(e, 'address.postalCode')}
            />
          </FieldGrid>
        </Section>
      )}

      {showItems && (
        <Section
          title="Items"
          description="Prices come from the catalog. Change one only for a negotiated price."
        >
          {first(e, 'items') && <Alert tone="error">{first(e, 'items')}</Alert>}
          <VariantPicker onPick={addLine} disabledIds={lines.map((l) => l.variantId)} />
          {lines.map((l, i) => (
            <Stack key={l.variantId} gap={2}>
              <Row gap={2} wrap justify="between">
                <Stack gap={1} grow>
                  <Text weight="bold">{l.label}</Text>
                  <Text variant="caption" tone="muted">
                    {l.sku}
                    {l.available !== null ? ` · ${l.available} available` : ''}
                  </Text>
                </Stack>
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() => setLines((all) => all.filter((_, j) => j !== i))}
                >
                  {`Remove ${l.sku}`}
                </Button>
              </Row>
              <FieldGrid minWidth={150}>
                <TextField
                  label={`Quantity (${l.sku})`}
                  kind="integer"
                  value={l.quantity}
                  onChangeText={(t) => patchLine(i, { quantity: t })}
                  error={first(e, `items.${i}.quantity`, `lines.${i}.quantity`)}
                />
                <TextField
                  label={`Price ৳ (${l.sku})`}
                  kind="decimal"
                  placeholder={priceToInput(l.catalogPriceMinor)}
                  value={l.unitPrice}
                  onChangeText={(t) => patchLine(i, { unitPrice: t })}
                  error={first(e, `items.${i}.unitPriceMinor`, `lines.${i}.unitPriceMinor`)}
                />
                <TextField
                  label={`Discount ৳ (${l.sku})`}
                  kind="decimal"
                  value={l.discount}
                  onChangeText={(t) => patchLine(i, { discount: t })}
                  error={first(e, `items.${i}.discountMinor`, `lines.${i}.discountMinor`)}
                />
              </FieldGrid>
            </Stack>
          ))}
        </Section>
      )}

      {showItems && (
        <Section
          title="Discount, delivery and advance"
          description="Cash on delivery is the total minus the advance. It is worked out for you."
        >
          <FieldGrid minWidth={170}>
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
            <TextField
              label="Advance paid (৳)"
              kind="decimal"
              {...field('advance')}
              error={first(e, 'advancePaidMinor')}
            />
          </FieldGrid>
          {estimate && 'problem' in estimate ? (
            <Alert tone="error">{estimate.problem}</Alert>
          ) : estimate ? (
            <Stack gap={1}>
              <KeyValueList
                items={[
                  { label: 'Items', value: formatPrice(estimate.subtotalMinor) },
                  { label: 'Discount', value: `−${formatPrice(estimate.discountMinor)}` },
                  { label: 'Delivery', value: formatPrice(estimate.deliveryChargeMinor) },
                  { label: 'Total', value: formatPrice(estimate.totalMinor) },
                  { label: 'Advance paid', value: formatPrice(estimate.advancePaidMinor) },
                  { label: 'Cash on delivery', value: formatPrice(estimate.codAmountMinor) },
                ]}
              />
              <Text variant="caption" tone="muted">
                An estimate. The final figures are worked out when you save.
              </Text>
            </Stack>
          ) : null}
        </Section>
      )}

      {(scope === 'full' || scope === 'contact' || scope === 'notes') && (
        <Section title="Source and notes">
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
          <TextField label="Notes" multiline {...field('notes')} error={first(e, 'notes')} />
        </Section>
      )}

      <Row gap={2} wrap>
        {editing ? (
          <Button type="submit" loading={form.busy}>
            Save changes
          </Button>
        ) : (
          <>
            <Button type="submit" loading={form.busy}>
              Create order
            </Button>
            <Button variant="secondary" loading={form.busy} onPress={() => submit(true)}>
              Create and confirm
            </Button>
          </>
        )}
        <Button variant="ghost" href={editing ? `/orders/${order!.id}` : '/orders'}>
          Cancel
        </Button>
      </Row>
      {!editing && (
        <Text variant="caption" tone="muted">
          “Create and confirm” also holds the stock for this order. Plain “Create” holds nothing
          until you confirm.
        </Text>
      )}
    </Form>
  );
}
