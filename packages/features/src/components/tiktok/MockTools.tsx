import type { TikTokConnection, TikTokMockResult } from '@orderloop/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
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
import { useApi } from '../../core/runtime';
import { useFormState } from '../../forms/forms';
import { currencyExponent, parseShopAmount } from '../../lib/shopMoney';
import {
  invalidateTikTok,
  MOCK_STATUSES,
  nextStatus,
  orderStatus,
  stockState,
} from '../../lib/tiktok';
import { ShopMoney, StockBadge, TikTokStatusBadge } from './Badges';

/** What happened to a test order, in words. */
function Outcome({ result }: { result: TikTokMockResult }) {
  if (result.duplicate)
    return <Text>This exact notification was already received. Nothing new was created.</Text>;
  if (result.status === 'ignored') return <Text>The order was ignored: nothing was stored.</Text>;
  if (result.status === 'failed') return <Text>The order could not be processed.</Text>;
  return (
    <Stack gap={1}>
      <Text>Order received.</Text>
      {result.stockState && <Text>{stockState(result.stockState).hint}</Text>}
      {result.orderId && (
        <Link href={`/tiktok-orders/${result.orderId}`} variant="inline">
          Open the order
        </Link>
      )}
    </Stack>
  );
}

/** The first SKU in the catalogue, so a test order can be for a real product. Null while loading or when there is none. */
function useCatalogueSku(): string | null {
  const api = useApi();
  const query = useQuery({
    queryKey: ['products', 'tiktok-mock-sku'],
    retry: false,
    queryFn: () => api.products.list({ limit: 1, status: 'ACTIVE' }),
  });
  return query.data?.items[0]?.variants.find((v) => !v.archived)?.sku ?? null;
}

/** Mock orders, newest first, each with the buttons that move it to its next status or cancel it. */
function MockOrders() {
  const api = useApi();
  const toast = useToast();
  const client = useQueryClient();
  const [working, setWorking] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['tiktokOrders', 'mock-tools'],
    retry: false,
    queryFn: () => api.tiktokOrders.list({ limit: 10 }),
  });
  const orders = (query.data?.items ?? []).filter((o) => o.mock);

  async function move(id: string, status: string) {
    setWorking(id);
    try {
      await api.tiktokShop.mockStatus(id, { status });
      await invalidateTikTok(client);
      toast.success(`Order moved to ${orderStatus(status).label}`);
    } catch {
      toast.error('The order could not be changed. Try again.');
    } finally {
      setWorking(null);
    }
  }

  if (orders.length === 0) return <Text tone="muted">Test orders you add appear here.</Text>;
  return (
    <Stack gap={3}>
      {orders.map((o) => {
        const next = nextStatus(o.status);
        return (
          <Card
            key={o.id}
            variant="outlined"
            padding="sm"
            role="group"
            aria-label={`Test order ${o.externalOrderId}`}
          >
            <Stack gap={2}>
              <Row gap={2} wrap justify="between">
                <Link href={`/tiktok-orders/${o.id}`} weight="medium">
                  {o.externalOrderId}
                </Link>
                <ShopMoney minor={o.totalMinor} order={o} />
              </Row>
              <Row gap={2} wrap>
                <TikTokStatusBadge status={o.status} onHold={o.onHold} />
                <StockBadge state={o.stockState} />
              </Row>
              <Row gap={2} wrap>
                {next && (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={working === o.id}
                    accessibilityLabel={`Move to ${orderStatus(next).label}, order ${o.externalOrderId}`}
                    onPress={() => move(o.id, next)}
                  >
                    {`Move to ${orderStatus(next).label}`}
                  </Button>
                )}
                {o.status !== 'CANCELLED' && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={working === o.id}
                    accessibilityLabel={`Cancel order ${o.externalOrderId}`}
                    onPress={() => move(o.id, 'CANCELLED')}
                  >
                    Cancel order
                  </Button>
                )}
              </Row>
            </Stack>
          </Card>
        );
      })}
    </Stack>
  );
}

/**
 * Mock mode only: add a simulated shop, send it simulated orders through the same pipeline a real one uses, and move them
 * through TikTok's statuses. Only for trying OrderLoop without a TikTok account: it says so, and nothing reaches TikTok.
 */
export function TikTokMockTools({ connections }: { connections: TikTokConnection[] }) {
  const api = useApi();
  const toast = useToast();
  const client = useQueryClient();
  const usable = connections.filter((c) => c.mock && c.status === 'active');
  const [connectionId, setConnectionId] = useState('');
  const [result, setResult] = useState<TikTokMockResult | null>(null);
  const catalogueSku = useCatalogueSku();
  const add = useFormState({ shopName: '', region: 'MY', currency: 'MYR' });
  const send = useFormState({
    sku: '',
    quantity: '1',
    status: 'AWAITING_SHIPMENT',
    price: '12',
  });
  const target = usable.find((c) => c.id === connectionId) ?? usable[0];

  // Offer a real SKU from the catalogue until the person types their own.
  const typed = send.values.sku !== '';
  useEffect(() => {
    if (!typed && catalogueSku) send.set('sku', catalogueSku);
  }, [catalogueSku, typed]);

  async function addShop() {
    const region = add.values.region.trim().toUpperCase();
    const currency = add.values.currency.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(region)) return add.setErrors({ region: 'Two letters, for example MY' });
    if (!/^[A-Z]{3}$/.test(currency))
      return add.setErrors({ currency: 'Three letters, for example MYR' });
    const name = add.values.shopName.trim();
    const ok = await add.run(async () => {
      await api.tiktokShop.mockConnection({
        region,
        currency,
        ...(name ? { shopName: name } : {}),
      });
      await invalidateTikTok(client);
    });
    if (ok) toast.success('Mock shop added');
  }

  async function sendOrder() {
    if (!target) return;
    const sku = send.values.sku.trim();
    const quantity = Number(send.values.quantity);
    const unitPriceMinor = parseShopAmount(
      send.values.price,
      currencyExponent(target.currency ?? 'MYR'),
    );
    if (!sku) return send.setErrors({ sku: 'Enter a SKU' });
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000)
      return send.setErrors({ quantity: 'Enter a whole number from 1 to 10000' });
    if (unitPriceMinor === null)
      return send.setErrors({ price: 'Enter an amount such as 12.00, with the right decimals' });
    setResult(null);
    const ok = await send.run(async () => {
      const sent = await api.tiktokShop.mockOrder({
        connectionId: target.id,
        status: send.values.status,
        onHold: false,
        items: [{ skuId: sku, sellerSku: sku, quantity, unitPriceMinor }],
      });
      setResult(sent);
      await invalidateTikTok(client);
    });
    if (!ok) setResult(null);
  }

  return (
    <Section
      title="Try it without TikTok"
      description="Add a simulated shop, then send it simulated orders and move them through TikTok’s statuses to see what happens to your stock."
    >
      <Stack gap={5}>
        <Stack gap={3}>
          <Text variant="heading">Add a mock shop</Text>
          {!!add.formError && <Alert tone="error">{add.formError}</Alert>}
          <Row gap={3} wrap align="end">
            <TextField label="Shop name (optional)" {...add.field('shopName')} />
            <TextField label="Region" {...add.field('region')} hint="Two letters, such as MY." />
            <TextField
              label="Currency"
              {...add.field('currency')}
              hint="Three letters, such as MYR."
            />
          </Row>
          <Row gap={3} wrap>
            <Button variant="secondary" icon="plus" loading={add.busy} onPress={addShop}>
              Add mock shop
            </Button>
          </Row>
        </Stack>

        <Stack gap={3}>
          <Text variant="heading">Send a test order</Text>
          {usable.length === 0 ? (
            <Text tone="muted">Add a mock shop first, then you can send it an order.</Text>
          ) : (
            <>
              {!!send.formError && <Alert tone="error">{send.formError}</Alert>}
              {usable.length > 1 && (
                <SelectField
                  label="Send to"
                  value={target?.id ?? ''}
                  onChange={setConnectionId}
                  options={usable.map((c) => ({ value: c.id, label: c.shopName }))}
                />
              )}
              <TextField
                label="SKU"
                {...send.field('sku')}
                hint="The SKU of a product in your catalogue reserves its stock. A SKU OrderLoop does not know waits for you to map it."
              />
              <TextField label="Quantity" kind="integer" {...send.field('quantity')} />
              <TextField
                label={`Unit price (${target?.currency ?? 'MYR'})`}
                kind="decimal"
                {...send.field('price')}
                hint="In the shop’s currency, not taka."
              />
              <SelectField
                label="Order status"
                value={send.values.status}
                onChange={(v) => send.set('status', v)}
                options={MOCK_STATUSES.map((s) => ({ value: s, label: orderStatus(s).label }))}
              />
              <Row gap={3} wrap>
                <Button loading={send.busy} onPress={sendOrder}>
                  Send test order
                </Button>
              </Row>
              {result && (
                <Alert tone={result.status === 'failed' ? 'error' : 'success'}>
                  <Outcome result={result} />
                </Alert>
              )}
            </>
          )}
        </Stack>

        <Stack gap={3}>
          <Row gap={2} wrap>
            <Text variant="heading">Test orders</Text>
            <Badge tone="warning">Mock</Badge>
          </Row>
          <MockOrders />
        </Stack>
      </Stack>
    </Section>
  );
}
