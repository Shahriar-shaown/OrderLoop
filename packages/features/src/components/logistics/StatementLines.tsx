import type { SettlementItem } from '@orderloop/contracts';
import { Badge, Link, Row, Stack, Text, type Column } from '@orderloop/ui';
import { DISCREPANCY_LABEL, MATCH_LABEL, MATCH_TONE } from '../../lib/finance';
import { formatPrice } from '../../lib/money';
import { SettlementItemActions } from './SettlementItemActions';

const charges = (i: SettlementItem) =>
  i.deliveryChargeMinor + i.codFeeMinor + i.returnChargeMinor + i.otherDeductionMinor;

const identifiers = (i: SettlementItem) =>
  [
    i.consignmentId && `Consignment ${i.consignmentId}`,
    i.trackingCode && `Tracking ${i.trackingCode}`,
    i.reference && `Ref ${i.reference}`,
  ].filter(Boolean) as string[];

/** What the statement line came to, in words: matched, not matched, needs a person, and any open difference. */
function Result({ item }: { item: SettlementItem }) {
  return (
    <Stack gap={1}>
      <Row gap={1} wrap>
        <Badge tone={MATCH_TONE[item.matchStatus]} dot>
          {MATCH_LABEL[item.matchStatus]}
        </Badge>
        {item.discrepancies
          .filter((d) => d.status === 'open')
          .map((d) => (
            <Badge key={d.id} tone="error" dot>
              {DISCREPANCY_LABEL[d.type]}
            </Badge>
          ))}
      </Row>
      {item.matchNote && (
        <Text variant="caption" tone="muted">
          {item.matchNote}
        </Text>
      )}
    </Stack>
  );
}

const orderLink = (i: SettlementItem) =>
  i.orderId ? <Link href={`/orders/${i.orderId}`}>{`#${i.orderNumber}`}</Link> : '—';

/** The columns of a table of statement lines: one set for the settlement page and the unmatched-lines list. */
export function statementLineColumns(): Column<SettlementItem>[] {
  return [
    { key: 'line', header: 'Line', minWidth: 56, show: 'wide', render: (i) => String(i.lineNo) },
    {
      key: 'ids',
      header: 'Consignment',
      flex: 2,
      minWidth: 170,
      render: (i) => (
        <Stack gap={1}>
          {identifiers(i).map((t) => (
            <Text key={t} variant="caption">
              {t}
            </Text>
          ))}
          {identifiers(i).length === 0 && (
            <Text variant="caption" tone="muted">
              none
            </Text>
          )}
          <Text variant="caption" tone="muted">
            {i.date}
          </Text>
        </Stack>
      ),
    },
    { key: 'order', header: 'Order', minWidth: 80, render: orderLink },
    { key: 'result', header: 'Result', flex: 2, minWidth: 190, render: (i) => <Result item={i} /> },
    {
      key: 'expected',
      header: 'Expected',
      align: 'right',
      minWidth: 100,
      show: 'desktop',
      render: (i) => (i.expectedMinor === null ? '—' : formatPrice(i.expectedMinor)),
    },
    {
      key: 'collected',
      header: 'Reported',
      align: 'right',
      minWidth: 100,
      render: (i) => formatPrice(i.collectedMinor),
    },
    {
      key: 'charges',
      header: 'Charges',
      align: 'right',
      minWidth: 90,
      show: 'desktop',
      render: (i) => formatPrice(charges(i)),
    },
    {
      key: 'net',
      header: 'Paid out',
      align: 'right',
      minWidth: 100,
      show: 'desktop',
      render: (i) => formatPrice(i.netMinor),
    },
    {
      key: 'act',
      header: '',
      flex: 2,
      minWidth: 210,
      render: (i) => <SettlementItemActions item={i} />,
    },
  ];
}

/** A statement line as a card on a phone. */
export function StatementLineCard({ item }: { item: SettlementItem }) {
  return (
    <Stack gap={2}>
      <Row justify="between" gap={2} align="start">
        <Stack gap={1} grow>
          <Text weight="medium">{`Line ${item.lineNo} · ${item.date}`}</Text>
          {identifiers(item).map((t) => (
            <Text key={t} variant="caption" tone="muted">
              {t}
            </Text>
          ))}
        </Stack>
        <Text numeric weight="medium">
          {formatPrice(item.collectedMinor)}
        </Text>
      </Row>
      <Row gap={2} wrap align="center">
        {orderLink(item)}
        <Result item={item} />
      </Row>
      <SettlementItemActions item={item} />
    </Stack>
  );
}
