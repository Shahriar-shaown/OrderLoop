import type { OrderTotals } from '@orderloop/domain';
import {
  Alert,
  Card,
  Icon,
  KeyValueList,
  Section,
  Stack,
  Text,
  useTheme,
  useT,
} from '@orderloop/ui';
import type { ReactNode } from 'react';
import { Row } from '@orderloop/ui';
import { formatPrice } from '../../lib/money';

export interface SummaryLine {
  label: string;
  quantity: number;
  totalMinor: number | undefined;
}

export interface ChecklistItem {
  label: string;
  ok: boolean;
}

function Checklist({ items }: { items: ChecklistItem[] }) {
  const { colors } = useTheme();
  const t = useT();
  return (
    <Stack gap={2} role="list" aria-label={t('Before you confirm')}>
      {items.map((c) => (
        <Row key={c.label} gap={2} role="listitem">
          <Icon
            name={c.ok ? 'check' : 'clock'}
            size={16}
            color={c.ok ? colors.tones.success.text : colors.muted}
          />
          <Text variant="small" tone={c.ok ? 'default' : 'muted'}>
            {`${c.label}${c.ok ? '' : ' — to do'}`}
          </Text>
        </Row>
      ))}
    </Stack>
  );
}

/**
 * The order summary beside the form: lines, subtotal, discount, delivery, and what the courier collects. Below it, your own
 * estimate of the margin (labelled as one, and never called profit: nothing is profit until the courier settles the cash).
 * The figures are the same function the server uses; the server's own win when the order is saved.
 */
export function OrderSummaryCard({
  lines,
  totals,
  productCostMinor,
  checklist,
  actions,
}: {
  lines: SummaryLine[];
  totals: OrderTotals | { problem: string } | null;
  /** Total cost of the products, when every line has a cost; otherwise null. */
  productCostMinor: number | null;
  checklist?: ChecklistItem[];
  actions?: ReactNode;
}) {
  const ok = totals && !('problem' in totals) ? totals : null;
  const gross =
    ok && productCostMinor !== null ? ok.subtotalMinor - ok.discountMinor - productCostMinor : null;
  return (
    <Section title="Order summary">
      <Stack gap={4}>
        {lines.length > 0 && (
          <Stack gap={2}>
            {lines.map((l) => (
              <Row key={l.label} justify="between" gap={3} align="start">
                <Text variant="small" tone="muted" style={{ flexShrink: 1 }}>
                  {`${l.label} × ${l.quantity}`}
                </Text>
                <Text variant="small" numeric>
                  {l.totalMinor !== undefined ? formatPrice(l.totalMinor) : '—'}
                </Text>
              </Row>
            ))}
          </Stack>
        )}
        {totals && 'problem' in totals ? (
          <Alert tone="error">{totals.problem}</Alert>
        ) : ok ? (
          <Stack gap={1}>
            <KeyValueList
              layout="inline"
              items={[
                { label: 'Subtotal', value: formatPrice(ok.subtotalMinor) },
                {
                  label: 'Discount',
                  value: `−${formatPrice(ok.discountMinor)}`,
                  tone: ok.discountMinor ? 'success' : 'muted',
                },
                { label: 'Delivery fee', value: formatPrice(ok.deliveryChargeMinor) },
                ...(ok.advancePaidMinor > 0
                  ? [
                      { label: 'Total', value: formatPrice(ok.totalMinor) },
                      { label: 'Advance paid', value: `−${formatPrice(ok.advancePaidMinor)}` },
                    ]
                  : []),
                {
                  label: 'Total · COD to collect',
                  value: formatPrice(ok.codAmountMinor),
                  emphasis: true,
                },
              ]}
            />
            <Text variant="caption" tone="muted">
              An estimate. The final figures are worked out when you save.
            </Text>
          </Stack>
        ) : (
          <Text tone="muted">
            {lines.length === 0
              ? 'Add a product to see the total.'
              : 'Fix the amounts to see the total.'}
          </Text>
        )}

        {ok && gross !== null && productCostMinor !== null && (
          <Card variant="filled" padding="sm">
            <Stack gap={2}>
              <Text variant="fine" tone="muted" style={{ textTransform: 'uppercase' }}>
                Your estimate · not profit yet
              </Text>
              <KeyValueList
                layout="inline"
                items={[
                  { label: 'Product cost', value: `−${formatPrice(productCostMinor)}` },
                  { label: 'Estimated gross profit', value: formatPrice(gross), emphasis: true },
                ]}
              />
              <Text variant="caption" tone="muted">
                Items minus discount minus product cost, before courier fees. Cash counts as profit
                only after the courier settles it.
              </Text>
            </Stack>
          </Card>
        )}

        {checklist && <Checklist items={checklist} />}
        {actions}
      </Stack>
    </Section>
  );
}
