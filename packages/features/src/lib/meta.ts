import type {
  MetaOverview,
  SocialConnection,
  SocialConnectionStatus,
  SocialDraftStatus,
  SocialProvider,
} from '@orderloop/contracts';
import type { Tone } from '@orderloop/ui';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../core/auth';
import { useApi } from '../core/runtime';
import { invalidateKeys } from './invalidate';

/** The notice every mock screen carries. It is worded once so every screen says the same thing. */
export const MOCK_NOTICE_TITLE = 'Mock integration: not connected to Meta';
export const MOCK_NOTICE_TEXT =
  'Accounts and messages here are simulated for testing. Nothing is sent to or received from Facebook or Instagram.';

export const PROVIDER_LABEL: Record<SocialProvider, string> = {
  facebook_page: 'Facebook',
  instagram: 'Instagram',
};

/** What a connection's status means and what to do about it, in plain words. */
export const CONNECTION_STATUS: Record<
  SocialConnectionStatus,
  { label: string; tone: Tone; explanation: string }
> = {
  active: {
    label: 'Active',
    tone: 'success',
    explanation: 'Customer messages to this account reach OrderLoop as draft orders.',
  },
  needs_reconnect: {
    label: 'Needs reconnecting',
    tone: 'warning',
    explanation:
      'Meta no longer accepts the saved access, for example after a password change. New messages are not arriving until you reconnect.',
  },
  permission_error: {
    label: 'Permission missing',
    tone: 'warning',
    explanation:
      'A permission was removed or was not approved. New messages may not arrive until you reconnect and approve every permission.',
  },
  disconnected: {
    label: 'Disconnected',
    tone: 'neutral',
    explanation: 'This account is not receiving messages. Connect it again to start.',
  },
};

/** Why a sign-in with Meta did not work (the `?error=` code OrderLoop is sent back with). */
export const OAUTH_ERRORS: Record<string, string> = {
  access_denied: 'You cancelled the sign-in with Meta, so nothing was connected.',
  invalid_state:
    'The sign-in link expired or was already used. Start the connection again from this page.',
  meta_not_configured:
    'Connecting to Meta is not set up on this server yet. Ask whoever runs the server to set it up.',
  meta_permission_denied:
    'Meta did not give OrderLoop every permission it needs, or you cannot manage that Page. Try again and approve every permission.',
  meta_token_invalid: 'Meta did not accept the sign-in. Try connecting again.',
  meta_unavailable: 'Meta could not be reached right now. Try again in a few minutes.',
  rate_limited: 'Meta is asking us to slow down. Wait a few minutes and try again.',
};
export const oauthErrorMessage = (code: string): string =>
  OAUTH_ERRORS[code] ?? 'The sign-in with Meta did not finish. Try connecting again.';

export const MOCK_SENDER = 'mock-customer-1';
/** A realistic order for the test tool: a Bangla message of the kind customers send. */
export const MOCK_MESSAGE =
  'আমি ২টা Demo Cotton T-Shirt নিব, নাম রিনা, ০১৭১২৩৪৫৬৭৮, বাসা ১২ রোড ৫ মিরপুর ঢাকা';

export const DRAFT_STATUS_LABEL: Record<SocialDraftStatus, string> = {
  needs_review: 'Needs review',
  confirmed: 'Confirmed',
  dismissed: 'Dismissed',
};
export const DRAFT_STATUS_TONE: Record<SocialDraftStatus, Tone> = {
  needs_review: 'warning',
  confirmed: 'success',
  dismissed: 'neutral',
};

/** What each warning code means for the person reviewing, in plain language. */
export const WARNING_TEXT: Record<string, string> = {
  no_phone: 'No phone number was found in the messages. Ask the customer for one.',
  multiple_phones: 'The customer wrote more than one phone number. Check which one to use.',
  no_address: 'No delivery address was found. Ask the customer for one.',
  no_items: 'No products were recognised. Add what the customer wants.',
  unmatched_item:
    'Some items do not match a product in your catalogue. Pick the product for each one.',
  low_confidence_item: 'Some items were matched with low confidence. Check them.',
  price_ignored:
    'The customer mentioned a price. It was ignored: prices always come from your catalogue.',
  duplicate_order: 'This may repeat an order that already exists. See the list below.',
};
export const warningText = (code: string, fallback: string): string =>
  WARNING_TEXT[code] ?? fallback;

export const CHECK_THIS = 'Check this: it was hard to read from the chat.';

/** A phone number for a list that may be seen over a shoulder: 017••••5678. The full number is on the review screen. */
export function maskPhone(phone: string | null): string {
  if (!phone) return 'No phone yet';
  const digits = phone.replace(/\D/g, '').replace(/^880/, '0');
  if (digits.length < 8) return '••••';
  return `${digits.slice(0, 3)}••••${digits.slice(-4)}`;
}

// ---- reading ------------------------------------------------------------------------------------------------------------

export function useMetaOverview(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: ['meta', 'overview'],
    enabled,
    queryFn: () => api.meta.overview(),
  });
}

export function useMetaSession(id: string | undefined, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ['meta', 'session', id],
    enabled: enabled && !!id,
    retry: false,
    queryFn: () => api.meta.session(id!),
  });
}

/** How often the menu asks how many drafts wait. One small request: it reads the count, not the list. */
export const DRAFT_COUNT_POLL_MS = 60_000;

/** Drafts waiting for review: the count beside "Social orders" in the menu. */
export function useDraftCount(enabled: boolean) {
  const api = useApi();
  const { status } = useAuth();
  return useQuery({
    queryKey: ['socialDrafts', 'count'],
    enabled: enabled && status === 'authenticated',
    refetchInterval: DRAFT_COUNT_POLL_MS,
    refetchIntervalInBackground: false,
    queryFn: async () => (await api.socialDrafts.list({ limit: 1 })).counts.needs_review,
  });
}

/** The drafts of one status, newest message first, a page at a time. */
export function useDraftList(status: SocialDraftStatus) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: ['socialDrafts', 'list', status],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.socialDrafts.list({ status, limit: 25, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

export function useDraft(id: string) {
  const api = useApi();
  return useQuery({ queryKey: ['socialDraft', id], queryFn: () => api.socialDrafts.get(id) });
}

export const invalidateDrafts = (client: ReturnType<typeof useQueryClient>) =>
  invalidateKeys(client, ['socialDrafts', 'socialDraft']);

export const invalidateMeta = (client: ReturnType<typeof useQueryClient>) =>
  invalidateKeys(client, ['meta', 'socialDrafts', 'socialDraft']);

export const isMock = (overview: MetaOverview | undefined, connection?: SocialConnection) =>
  overview?.mode === 'mock' || connection?.mock === true;

/** A message id that depends only on who sent what to which account: sending the same text again is the same message. */
export function mockMessageId(connectionId: string, senderId: string, text: string): string {
  // FNV-1a over the three parts: not a secret, only a stable name for "the same message".
  let hash = 0x811c9dc5;
  for (const char of `${connectionId}\u0000${senderId}\u0000${text}`) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `mock-msg-${hash.toString(16).padStart(8, '0')}-${text.length}`;
}
