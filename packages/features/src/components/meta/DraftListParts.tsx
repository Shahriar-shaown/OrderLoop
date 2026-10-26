import type { SocialDraftSummary } from '@orderloop/contracts';
import { Badge, Link, Row, Stack, Text, type Column } from '@orderloop/ui';
import { formatWhen } from '../../lib/format';
import { DRAFT_STATUS_LABEL, DRAFT_STATUS_TONE, maskPhone } from '../../lib/meta';
import { SourceBadge } from './SourceBadge';

/** The API gives the first 60 characters of the first message: a snippet that long was probably cut off. */
const SNIPPET_LENGTH = 60;

/** A table cell lets its content grow to its natural width: cap it at the cell so a long message is cut with "…" instead of running into the next column. */
const FIT = { maxWidth: '100%' } as const;

const who = (d: SocialDraftSummary) => d.customerName ?? 'Name not found yet';

/** The start of the first message, as a list label. It is the customer's own words: shown as written, never translated. */
function Snippet({ draft }: { draft: SocialDraftSummary }) {
  if (!draft.snippet) return null;
  return (
    <Text variant="caption" tone="muted" verbatim numberOfLines={1}>
      {draft.snippet.length >= SNIPPET_LENGTH ? `${draft.snippet.trimEnd()}…` : draft.snippet}
    </Text>
  );
}

/** "Order #123" for a draft that became an order, a link to it. */
function OrderLink({ draft }: { draft: SocialDraftSummary }) {
  if (!draft.orderId || draft.orderNumber === null) return null;
  return <Link href={`/orders/${draft.orderId}`}>{`Order #${draft.orderNumber}`}</Link>;
}

/** "2 items" with how many still need a product picked. */
function Items({ draft }: { draft: SocialDraftSummary }) {
  return (
    <Row gap={2} wrap>
      <Text>{`${draft.itemCount} item${draft.itemCount === 1 ? '' : 's'}`}</Text>
      {draft.status === 'needs_review' && draft.unmatchedItemCount > 0 && (
        <Badge tone="warning">{`${draft.unmatchedItemCount} to pick`}</Badge>
      )}
    </Row>
  );
}

export const draftColumns: Column<SocialDraftSummary>[] = [
  {
    key: 'customer',
    header: 'Customer',
    flex: 2,
    minWidth: 160,
    render: (d) => (
      <Stack gap={2} style={FIT}>
        <Stack gap={1}>
          <Link href={`/social-orders/${d.id}`} weight="medium">
            {who(d)}
          </Link>
          {/* A list can be seen over a shoulder: the full number is on the review screen. */}
          <Text variant="caption" tone="muted">
            {maskPhone(d.phone)}
          </Text>
        </Stack>
        <Snippet draft={d} />
      </Stack>
    ),
  },
  {
    key: 'source',
    header: 'From',
    flex: 1.5,
    minWidth: 150,
    render: (d) => (
      <Stack gap={2} style={FIT}>
        <SourceBadge provider={d.provider} mock={d.mock} />
        <Text variant="caption" tone="muted" numberOfLines={1}>
          {d.connectionName}
        </Text>
      </Stack>
    ),
  },
  { key: 'items', header: 'Items', flex: 1, minWidth: 110, render: (d) => <Items draft={d} /> },
  {
    key: 'messages',
    header: 'Messages',
    minWidth: 90,
    show: 'wide',
    render: (d) => `${d.messageCount}`,
  },
  {
    key: 'last',
    header: 'Last message',
    flex: 1.5,
    minWidth: 150,
    show: 'wide',
    render: (d) => formatWhen(d.lastMessageAt),
  },
  {
    key: 'status',
    header: 'Status',
    minWidth: 120,
    render: (d) => (
      <Stack gap={1}>
        <Badge tone={DRAFT_STATUS_TONE[d.status]} dot>
          {DRAFT_STATUS_LABEL[d.status]}
        </Badge>
        <OrderLink draft={d} />
      </Stack>
    ),
  },
];

/** A draft as a card on a phone. */
export function DraftCard({ draft }: { draft: SocialDraftSummary }) {
  return (
    <Stack gap={2}>
      <Row justify="between" gap={2} wrap>
        <Link href={`/social-orders/${draft.id}`} weight="medium">
          {who(draft)}
        </Link>
        <Badge tone={DRAFT_STATUS_TONE[draft.status]} dot>
          {DRAFT_STATUS_LABEL[draft.status]}
        </Badge>
      </Row>
      <Text variant="caption" tone="muted">
        {maskPhone(draft.phone)}
      </Text>
      <Snippet draft={draft} />
      <SourceBadge provider={draft.provider} mock={draft.mock} />
      <Items draft={draft} />
      <OrderLink draft={draft} />
      <Text variant="caption" tone="muted">
        {formatWhen(draft.lastMessageAt)}
      </Text>
    </Stack>
  );
}
