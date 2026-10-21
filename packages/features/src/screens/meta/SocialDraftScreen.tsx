import type { SocialDraft } from '@orderloop/contracts';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Link,
  PageHeader,
  Stack,
  Text,
  useToast,
} from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { DraftDuplicates } from '../../components/meta/DraftDuplicates';
import { DraftMessages } from '../../components/meta/DraftMessages';
import { DraftReadOnly } from '../../components/meta/DraftReadOnly';
import { DraftWarnings } from '../../components/meta/DraftWarnings';
import { MockNotice } from '../../components/meta/MockNotice';
import { SourceBadge } from '../../components/meta/SourceBadge';
import { OrderForm } from '../../components/orders/OrderForm';
import { useCan } from '../../core/permissions';
import { useApi } from '../../core/runtime';
import { ReasonDialog } from '../../forms/ReasonDialog';
import { formatWhen } from '../../lib/format';
import { DRAFT_STATUS_LABEL, DRAFT_STATUS_TONE, invalidateDrafts, useDraft } from '../../lib/meta';
import { QueryBoundary } from '../../shell/QueryBoundary';

function ClosedBanner({ draft }: { draft: SocialDraft }) {
  if (draft.status === 'confirmed')
    return (
      <Alert
        tone="success"
        title="This draft was confirmed"
        action={
          draft.orderId ? (
            <Button variant="secondary" size="sm" href={`/orders/${draft.orderId}`}>
              Open the order
            </Button>
          ) : undefined
        }
      >
        <Stack gap={1}>
          {draft.orderNumber !== null && (
            <Text weight="medium">{`Order #${draft.orderNumber}`}</Text>
          )}
          <Text>
            {draft.reviewedAt
              ? `Confirmed ${formatWhen(draft.reviewedAt)}. It cannot be changed here.`
              : 'It cannot be changed here.'}
          </Text>
        </Stack>
      </Alert>
    );
  return (
    <Alert tone="info" title="This draft was dismissed">
      <Stack gap={1}>
        <Text>
          {draft.reviewedAt
            ? `Dismissed ${formatWhen(draft.reviewedAt)}. No order was made.`
            : 'No order was made.'}
        </Text>
        {!!draft.dismissedReason && (
          <Stack gap={1}>
            <Text weight="medium">Reason</Text>
            <Text>{draft.dismissedReason}</Text>
          </Stack>
        )}
      </Stack>
    </Alert>
  );
}

/**
 * Review one draft: the customer's messages word for word, then the order form filled in from them. Fields read with low
 * confidence say "check this"; products come from the catalogue (the chat's price is never used). Confirming makes the
 * order through the normal order path. Someone who may only read orders, and a draft that is already closed, see the
 * facts and no form.
 */
export function SocialDraftScreen({ id }: { id: string }) {
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const client = useQueryClient();
  const query = useDraft(id);
  const [dismissing, setDismissing] = useState(false);
  const draft = query.data;
  const editable = can('orders:write') && draft?.status === 'needs_review';

  async function dismiss(reason: string) {
    try {
      const saved = await api.socialDrafts.dismiss(id, reason || undefined);
      client.setQueryData(['socialDraft', id], saved);
      await invalidateDrafts(client);
      toast.success('Draft dismissed');
    } catch (error) {
      // Already closed by someone else: reload it so the screen shows what it is now, and still say so.
      await invalidateDrafts(client);
      throw error;
    }
  }

  if (!can('orders:read'))
    return (
      <Stack gap={5}>
        <PageHeader title="Draft order" />
        <EmptyState icon="shield" title="You do not have access to orders">
          Ask an owner or admin if you need to see orders from messages.
        </EmptyState>
      </Stack>
    );

  return (
    <Stack gap={5}>
      <PageHeader
        breadcrumbs={[
          { label: 'Social orders', href: '/social-orders' },
          { label: 'Review draft' },
        ]}
        title="Review draft order"
        description="Check what the customer wrote against the form. Nothing is ordered until you confirm."
        badges={
          draft ? (
            <>
              <SourceBadge provider={draft.provider} mock={draft.mock} />
              <Badge tone={DRAFT_STATUS_TONE[draft.status]} dot>
                {DRAFT_STATUS_LABEL[draft.status]}
              </Badge>
            </>
          ) : undefined
        }
      />
      <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading draft">
        {draft && (
          <Stack gap={5}>
            {(draft.mock || draft.mode === 'mock') && <MockNotice />}
            {draft.status !== 'needs_review' && <ClosedBanner draft={draft} />}
            {draft.status === 'needs_review' && !can('orders:write') && (
              <Alert tone="info">
                Your role can look at drafts but not confirm or dismiss them. Ask an owner, admin or
                manager.
              </Alert>
            )}
            <DraftMessages messages={draft.messages} />
            {draft.status === 'needs_review' && <DraftWarnings warnings={draft.warnings} />}
            {editable ? (
              <OrderForm
                draft={draft}
                extraActions={
                  <Button variant="secondary" fullWidth onPress={() => setDismissing(true)}>
                    Dismiss draft
                  </Button>
                }
              />
            ) : (
              <Stack gap={5}>
                {draft.status === 'needs_review' && (
                  <DraftDuplicates duplicates={draft.duplicates} />
                )}
                <DraftReadOnly draft={draft} />
                <Link href="/social-orders" variant="inline">
                  Back to social orders
                </Link>
              </Stack>
            )}
          </Stack>
        )}
      </QueryBoundary>
      <ReasonDialog
        open={dismissing}
        optional
        danger
        title="Dismiss this draft?"
        label="Reason (optional)"
        submitLabel="Dismiss draft"
        onSubmit={dismiss}
        onClose={() => setDismissing(false)}
      />
    </Stack>
  );
}
