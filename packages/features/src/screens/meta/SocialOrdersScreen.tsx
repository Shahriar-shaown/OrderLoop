import type { SocialDraftStatus } from '@orderloop/contracts';
import {
  DataTable,
  EmptyState,
  LoadMore,
  PageHeader,
  Stack,
  Tabs,
  useNavigation,
  type TabItem,
} from '@orderloop/ui';
import { useState } from 'react';
import { DraftCard, draftColumns } from '../../components/meta/DraftListParts';
import { MockNotice } from '../../components/meta/MockNotice';
import { useCan } from '../../core/permissions';
import { DRAFT_STATUS_LABEL, useDraftList } from '../../lib/meta';
import { QueryBoundary } from '../../shell/QueryBoundary';

const STATUSES: SocialDraftStatus[] = ['needs_review', 'confirmed', 'dismissed'];

const EMPTY: Record<SocialDraftStatus, { title: string; text: string }> = {
  needs_review: {
    title: 'No messages to review',
    text: 'When a customer messages your connected Facebook Page or Instagram account with an order, a draft appears here for you to check. Nothing is ordered until someone confirms it.',
  },
  confirmed: {
    title: 'No confirmed drafts yet',
    text: 'Drafts that someone confirmed, and the orders they made, are listed here.',
  },
  dismissed: {
    title: 'No dismissed drafts',
    text: 'Drafts that someone decided not to turn into an order are listed here.',
  },
};

/**
 * Social orders: draft orders made from customer messages on Facebook and Instagram, waiting for a person to check them.
 * Customer phone numbers are masked in the list (it can be seen over a shoulder); the review screen shows everything.
 */
export function SocialOrdersScreen() {
  const can = useCan();
  const navigation = useNavigation();
  const [status, setStatus] = useState<SocialDraftStatus>('needs_review');
  const query = useDraftList(status);

  if (!can('orders:read'))
    return (
      <Stack gap={5}>
        <PageHeader title="Social orders" />
        <EmptyState icon="shield" title="You do not have access to orders">
          Ask an owner or admin if you need to see orders from messages.
        </EmptyState>
      </Stack>
    );

  const pages = query.data?.pages ?? [];
  const counts = pages[0]?.counts;
  const rows = pages.flatMap((p) => p.items);
  const mock = pages[0]?.mode === 'mock' || rows.some((d) => d.mock);
  const tabs: TabItem[] = STATUSES.map((s) => ({
    value: s,
    label: DRAFT_STATUS_LABEL[s],
    count: counts?.[s],
  }));
  const empty = EMPTY[status];

  return (
    <Stack gap={5}>
      <PageHeader
        title="Social orders"
        description="Orders customers sent as messages on Facebook and Instagram. Check each draft, fix anything that was misread, then confirm it to make the order."
      />
      {mock && <MockNotice />}
      <Tabs
        variant="chips"
        label="Draft status"
        items={tabs}
        value={status}
        onChange={(v) => setStatus(v as SocialDraftStatus)}
      />
      {query.isError && rows.length === 0 ? (
        <QueryBoundary
          isPending={false}
          isError
          error={query.error}
          refetch={() => query.refetch()}
        >
          {null}
        </QueryBoundary>
      ) : (
        <DataTable
          label="Social orders"
          columns={draftColumns}
          rows={rows}
          rowKey={(d) => d.id}
          loading={query.isPending}
          empty={
            <EmptyState icon="message" title={empty.title}>
              {empty.text}
            </EmptyState>
          }
          onRowPress={(d) => navigation.push(`/social-orders/${d.id}`)}
          rowLabel={(d) => `Draft from ${d.customerName ?? 'a customer'}`}
          renderCard={(d) => <DraftCard draft={d} />}
          footer={
            <LoadMore
              hasNext={query.hasNextPage}
              loading={query.isFetchingNextPage}
              onPress={() => void query.fetchNextPage()}
            />
          }
        />
      )}
    </Stack>
  );
}
