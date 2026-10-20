import type { OrderImportPreview, OrderImportResult } from '@orderloop/contracts';
import {
  Alert,
  Badge,
  Button,
  Form,
  PageHeader,
  Row,
  Section,
  Stack,
  Text,
  TextField,
} from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { FormError } from '../../forms/FormError';
import { useFormState } from '../../forms/forms';
import { formatPrice } from '../../lib/money';
import { invalidateOrders } from '../../lib/orders';
import { useCan } from '../../core/permissions';
import { useApi } from '../../core/runtime';

const TEMPLATE =
  'order_ref,customer_name,phone,address_line,area,district,division,sku,quantity,unit_price,discount,delivery_charge,advance_paid,source,notes\nF-1001,Rina Akter,01712-345678,"House 5, Road 3",Dhanmondi,Dhaka,Dhaka,TEE-RED-M,2,,100,60,200,facebook,Eid offer\nF-1001,,,,,,,MUG-1,1,250,,,,,\n';

/** Bring in orders from a spreadsheet. The file is checked first; orders arrive pending confirmation and hold no stock. */
export function OrdersImportScreen() {
  const api = useApi();
  const can = useCan();
  const queryClient = useQueryClient();
  const form = useFormState({ csv: '' });
  const [checked, setChecked] = useState<{ csv: string; preview: OrderImportPreview } | null>(null);
  const [result, setResult] = useState<OrderImportResult | null>(null);
  if (!can('orders:write'))
    return <Alert tone="warning">Your role can view orders but not import them.</Alert>;
  const current = checked && checked.csv === form.values.csv ? checked.preview : null;

  async function check() {
    if (!form.values.csv.trim()) return form.setErrors({ csv: 'Paste your CSV first' });
    const csv = form.values.csv;
    let preview: OrderImportPreview | null = null;
    setResult(null);
    const ok = await form.run(async () => {
      preview = await api.orders.validateImport(csv);
    });
    if (ok && preview) setChecked({ csv, preview });
  }
  async function start() {
    if (!current || current.fatal || current.validOrders === 0) return;
    let done: OrderImportResult | null = null;
    const ok = await form.run(async () => {
      done = await api.orders.import(form.values.csv);
      await invalidateOrders(queryClient);
    });
    if (ok && done) {
      setResult(done);
      setChecked(null);
    }
  }

  return (
    <Stack gap={5}>
      <PageHeader
        breadcrumbs={[{ label: 'Orders', href: '/orders' }, { label: 'Import' }]}
        title="Import orders"
        description="One row per order line; rows with the same order_ref are one order. Totals are never read from the file: they are worked out from quantities and prices."
        actions={
          <Button href="/orders" variant="secondary">
            Back to orders
          </Button>
        }
      />
      <Section
        title="Paste your CSV"
        description="Required: order_ref, customer_name, phone, address_line, area, district, division, sku, quantity. Optional: recipient_name, postal_code, unit_price, line_discount, discount, delivery_charge, advance_paid, source, source_reference, notes."
      >
        <Form onSubmit={check}>
          <FormError message={form.formError} />
          <TextField
            label="CSV"
            multiline
            numberOfLines={8}
            placeholder={TEMPLATE}
            autoCapitalize="none"
            autoCorrect={false}
            {...form.field('csv')}
          />
          <Row gap={2} wrap>
            <Button type="submit" loading={form.busy && !current}>
              Check file
            </Button>
            <Button variant="secondary" onPress={() => form.set('csv', TEMPLATE)}>
              Use the example
            </Button>
          </Row>
        </Form>
      </Section>
      {current && (
        <Section title="Check result">
          {current.fatal ? (
            <Alert tone="error" title="This file cannot be imported">
              {current.fatal}
            </Alert>
          ) : (
            <Stack gap={3}>
              <Row gap={2} wrap>
                <Badge tone="success">{`${current.validOrders} orders to create`}</Badge>
                {current.alreadyImported > 0 && (
                  <Badge tone="info">{`${current.alreadyImported} already imported`}</Badge>
                )}
                <Badge
                  tone={current.errorCount ? 'error' : 'neutral'}
                >{`${current.errorCount} problems`}</Badge>
              </Row>
              <Text>
                {`${current.totalRows} rows, ${current.orderCount} orders. They would total ${formatPrice(current.totalMinor)}. Nothing has been created yet.`}
              </Text>
              {current.errors.length > 0 && (
                <Alert tone="warning" title="Orders that would be skipped">
                  <Stack gap={1}>
                    {current.errors.slice(0, 20).map((e) => (
                      <Text key={`${e.row}:${e.message}`}>{`Row ${e.row}: ${e.message}`}</Text>
                    ))}
                    {current.errorCount > 20 && (
                      <Text>{`…and ${current.errorCount - 20} more.`}</Text>
                    )}
                  </Stack>
                </Alert>
              )}
              {current.validOrders > 0 && (
                <Stack align="start">
                  <Button loading={form.busy} onPress={start}>
                    {current.errorCount > 0
                      ? `Import ${current.validOrders} good orders, skip the rest`
                      : `Import ${current.validOrders} orders`}
                  </Button>
                </Stack>
              )}
            </Stack>
          )}
        </Section>
      )}
      {result && (
        <Alert tone={result.failed ? 'warning' : 'success'} title="Import finished">
          <Stack gap={1}>
            <Text>{`${result.created} created, ${result.alreadyImported} were already imported, ${result.failed} skipped.`}</Text>
            {result.errors.slice(0, 10).map((e) => (
              <Text key={`${e.row}:${e.message}`}>{`Row ${e.row}: ${e.message}`}</Text>
            ))}
            <Button href="/orders" variant="secondary">
              View orders
            </Button>
          </Stack>
        </Alert>
      )}
    </Stack>
  );
}
