import { z } from 'zod';
import { Uuid } from './auth.js';
import { CreateOrderBody, OrderDetail, PotentialDuplicate } from './orders.js';

// ---- vocabulary -------------------------------------------------------------------------------------------------------

/** `mock`: a clearly labelled simulated provider (no Meta account). `live`: the real Meta, see docs/meta.md for what is verified. */
export const MetaMode = z.enum(['mock', 'live']);
export type MetaMode = z.infer<typeof MetaMode>;

export const SOCIAL_PROVIDERS = ['facebook_page', 'instagram'] as const;
export const SocialProvider = z.enum(SOCIAL_PROVIDERS);
export type SocialProvider = z.infer<typeof SocialProvider>;

/** `needs_reconnect`: Meta no longer accepts the saved access. `permission_error`: a permission was removed or is missing. */
export const SOCIAL_CONNECTION_STATUSES = [
  'active',
  'needs_reconnect',
  'permission_error',
  'disconnected',
] as const;
export const SocialConnectionStatus = z.enum(SOCIAL_CONNECTION_STATUSES);
export type SocialConnectionStatus = z.infer<typeof SocialConnectionStatus>;

export const SocialDraftStatus = z.enum(['needs_review', 'confirmed', 'dismissed']);
export type SocialDraftStatus = z.infer<typeof SocialDraftStatus>;

/** The only permissions asked for at sign-in. */
export const META_SCOPES = [
  'pages_show_list',
  'pages_messaging',
  'pages_manage_metadata',
  'instagram_basic',
  'instagram_manage_messages',
] as const;

// ---- what extraction finds (stored on the draft; see packages/domain extractDraft) -------------------------------------

const Confidence = z.number().min(0).max(1);
const SourceIds = z.array(z.string()).max(200);
const field = <T extends z.ZodType>(value: T) =>
  z.object({ value, confidence: Confidence, sourceEventIds: SourceIds });

export const ExtractedItem = z.object({
  /** Set only when the text matched a catalogue variant with enough confidence; otherwise the reviewer maps it. */
  variantId: Uuid.nullable(),
  /** The customer's words for it (or the catalogue name when matched by a person). */
  text: z.string().max(300),
  quantity: z.number().int().min(1).max(10_000),
  confidence: Confidence,
  sourceEventIds: SourceIds,
});
export type ExtractedItem = z.infer<typeof ExtractedItem>;

export const ExtractedDraft = z.object({
  customerName: field(z.string()).optional(),
  /** Canonical `+8801XXXXXXXXX`. */
  phone: field(z.string()).optional(),
  address: field(z.string()).optional(),
  district: field(z.string()).optional(),
  /** Thana or upazila. Extraction never fills it: a person types it (kept for the shape of an override). */
  area: field(z.string()).optional(),
  /** 4 digits. Extraction never fills it: a person types it. */
  postalCode: field(z.string()).optional(),
  note: field(z.string()).optional(),
  /** Only a person types this: price statements in chat are never trusted. Kept for the shape of an override. */
  codAmountMinor: field(z.number().int().min(0)).optional(),
  items: z.array(ExtractedItem).max(50),
  /** Machine-readable reasons for the reviewer to look closer: no_phone, no_address, no_items, unmatched_item, low_confidence_item, price_ignored, multiple_phones. */
  warnings: z.array(z.string()).max(30),
});
export type ExtractedDraft = z.infer<typeof ExtractedDraft>;

// ---- connections ------------------------------------------------------------------------------------------------------

export const SocialConnection = z.object({
  id: Uuid,
  provider: SocialProvider,
  /** Page id or Instagram user id. */
  externalId: z.string(),
  displayName: z.string(),
  username: z.string().nullable(),
  /** For Instagram: the Facebook Page it is linked to. */
  linkedPageId: z.string().nullable(),
  status: SocialConnectionStatus,
  /** True for the simulated provider: label it. */
  mock: z.boolean(),
  scopes: z.array(z.string()),
  tokenExpiresAt: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  /** A short code (e.g. `token_invalid`, `permission_denied`) and a sentence with no tokens in it. */
  lastErrorCode: z.string().nullable(),
  lastErrorMessage: z.string().nullable(),
  connectedAt: z.string(),
  disconnectedAt: z.string().nullable(),
});
export type SocialConnection = z.infer<typeof SocialConnection>;

export const MetaOverview = z.object({
  mode: MetaMode,
  /** Live mode only: whether this server has everything the real Meta needs (it cannot be used otherwise). */
  liveConfigured: z.boolean(),
  /** The callback URL and verify-token hint to paste in the Meta dashboard (live), else null. The token itself is never returned. */
  webhookUrl: z.string().nullable(),
  /** The permissions asked for at sign-in. */
  scopes: z.array(z.string()),
  connections: z.array(SocialConnection),
  openDrafts: z.number().int(),
});
export type MetaOverview = z.infer<typeof MetaOverview>;

export const OauthStartBody = z.object({}).strict();
/**
 * `authorizeUrl` is a one-time link (60 seconds, single use) to the API's `GET /v1/integrations/meta/oauth/begin`, to be opened as a
 * top-level navigation: the API binds the sign-in to that browser with a cookie and then redirects to Meta. It is not Meta's URL.
 */
export const OauthStartResult = z.object({
  mode: MetaMode,
  authorizeUrl: z.string(),
});
export type OauthStartResult = z.infer<typeof OauthStartResult>;

export const OauthBeginQuery = z.object({
  ticket: z.string().max(200).optional(),
});

export const OauthCallbackQuery = z.object({
  code: z.string().max(2000).optional(),
  state: z.string().max(2000).optional(),
  error: z.string().max(200).optional(),
  error_reason: z.string().max(200).optional(),
  error_description: z.string().max(1000).optional(),
});

export const OauthPage = z.object({
  id: z.string(),
  name: z.string(),
  instagram: z.object({ id: z.string(), username: z.string().nullable() }).nullable(),
  /** Already connected to a business (this one or another): cannot be selected. */
  alreadyConnected: z.boolean(),
});
export const OauthSession = z.object({
  mode: MetaMode,
  id: Uuid,
  expiresAt: z.string(),
  pages: z.array(OauthPage),
  reconnectConnectionId: Uuid.nullable(),
});
export type OauthSession = z.infer<typeof OauthSession>;

export const ConnectPagesBody = z.object({
  sessionId: Uuid,
  pageIds: z.array(z.string().min(1).max(64)).min(1).max(25),
});
export type ConnectPagesBody = z.infer<typeof ConnectPagesBody>;
export const ConnectFailure = z.object({
  pageId: z.string(),
  code: z.string(),
  message: z.string(),
});
export const ConnectPagesResult = z.object({
  mode: MetaMode,
  connections: z.array(SocialConnection),
  /** Pages that could not be connected, each with an error code from the API's error table. When none could, the call fails instead. */
  failures: z.array(ConnectFailure),
});
export type ConnectPagesResult = z.infer<typeof ConnectPagesResult>;

export const MockConnectionBody = z
  .object({
    provider: SocialProvider.default('facebook_page'),
    displayName: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
export type MockConnectionBody = z.infer<typeof MockConnectionBody>;

export const MockEventBody = z
  .object({
    connectionId: Uuid,
    /** An opaque customer id; the same id continues the same conversation. */
    senderId: z.string().trim().min(1).max(64).default('mock-customer-1'),
    text: z.string().max(2000).optional(),
    attachmentTypes: z.array(z.string().max(20)).max(10).optional(),
    /** Repeat a message id to replay it: it must create nothing new. */
    messageId: z.string().trim().min(1).max(128).optional(),
    /** When it was "sent"; defaults to now. */
    timestamp: z.string().datetime().optional(),
  })
  .strict();
export type MockEventBody = z.infer<typeof MockEventBody>;
export const MockEventResult = z.object({
  mode: MetaMode,
  mock: z.literal(true),
  eventId: Uuid,
  messageId: z.string(),
  /** The same message id arrived before: nothing new was stored. */
  duplicate: z.boolean(),
  status: z.enum(['received', 'processed', 'ignored', 'failed']),
  draftId: Uuid.nullable(),
});
export type MockEventResult = z.infer<typeof MockEventResult>;

// ---- webhooks and Meta's two callbacks --------------------------------------------------------------------------------

export const WebhookVerifyQuery = z.object({
  'hub.mode': z.string().max(50).optional(),
  'hub.verify_token': z.string().max(500).optional(),
  'hub.challenge': z.string().max(500).optional(),
});
export const WebhookReceiveAck = z.object({ status: z.string() });

export const SignedRequestBody = z.object({ signed_request: z.string().min(10).max(10_000) });
export const DeauthorizeAck = z.object({}).strict();
export const DataDeletionAck = z.object({ url: z.string(), confirmation_code: z.string() });
export const DataDeletionStatusQuery = z.object({ code: z.string().min(8).max(100) });
export const DataDeletionStatus = z.object({
  confirmationCode: z.string(),
  status: z.literal('completed'),
});

// ---- drafts ------------------------------------------------------------------------------------------------------------

export const DraftWarning = z.object({ code: z.string(), message: z.string() });

const EffectiveField = <T extends z.ZodType>(value: T) =>
  field(value).extend({ edited: z.boolean() });

export const DraftItem = ExtractedItem.extend({
  edited: z.boolean(),
  /** The catalogue item it is mapped to, with today's price (the price in the chat is never used). */
  match: z
    .object({
      sku: z.string(),
      productName: z.string(),
      variantName: z.string(),
      priceMinor: z.number().int(),
      available: z.number().int().nullable(),
    })
    .nullable(),
});
export type DraftItem = z.infer<typeof DraftItem>;

export const DraftFields = z.object({
  customerName: EffectiveField(z.string()).optional(),
  phone: EffectiveField(z.string()).optional(),
  address: EffectiveField(z.string()).optional(),
  district: EffectiveField(z.string()).optional(),
  area: EffectiveField(z.string()).optional(),
  postalCode: EffectiveField(z.string()).optional(),
  note: EffectiveField(z.string()).optional(),
  codAmountMinor: EffectiveField(z.number().int()).optional(),
  items: z.array(DraftItem),
});
export type DraftFields = z.infer<typeof DraftFields>;

export const DraftMessage = z.object({
  id: Uuid,
  /** What the customer wrote. Null when it was only an attachment. */
  text: z.string().nullable(),
  /** Attachment kinds only (image, audio, ...): nothing is downloaded. */
  attachmentTypes: z.array(z.string()),
  at: z.string(),
});

export const SocialDraftSummary = z.object({
  id: Uuid,
  status: SocialDraftStatus,
  mock: z.boolean(),
  provider: SocialProvider,
  connectionId: Uuid,
  connectionName: z.string(),
  /** Opaque id of the customer on that platform: not a name or a number. */
  senderId: z.string(),
  customerName: z.string().nullable(),
  phone: z.string().nullable(),
  /** The first 60 characters of the first customer message that has text (null when none has): a list label, never any other data. */
  snippet: z.string().nullable(),
  itemCount: z.number().int(),
  /** Items still not mapped to a catalogue variant: confirming needs every item mapped. */
  unmatchedItemCount: z.number().int(),
  messageCount: z.number().int(),
  firstMessageAt: z.string(),
  lastMessageAt: z.string(),
  orderId: Uuid.nullable(),
  /** The number of the order made from this draft (confirmed drafts), else null. */
  orderNumber: z.number().int().nullable(),
});
export type SocialDraftSummary = z.infer<typeof SocialDraftSummary>;

export const SocialDraft = SocialDraftSummary.extend({
  mode: MetaMode,
  fields: DraftFields,
  /** The division the district is in (an order needs one): a hint for the form, null when the district is unknown. */
  suggestedDivision: z.string().nullable(),
  warnings: z.array(DraftWarning),
  /** Source messages, oldest first, so a person can check the draft against what was written. */
  messages: z.array(DraftMessage),
  /** Orders that look like a repeat (the normal duplicate check) plus recent orders already made from this customer's chat. */
  duplicates: z.array(PotentialDuplicate),
  dismissedReason: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type SocialDraft = z.infer<typeof SocialDraft>;

export const SocialDraftQuery = z.object({
  status: SocialDraftStatus.optional(),
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type SocialDraftQuery = z.infer<typeof SocialDraftQuery>;
export const SocialDraftPage = z.object({
  mode: MetaMode,
  items: z.array(SocialDraftSummary),
  nextCursor: z.string().nullable(),
  counts: z.object({
    needs_review: z.number().int(),
    confirmed: z.number().int(),
    dismissed: z.number().int(),
  }),
});
export type SocialDraftPage = z.infer<typeof SocialDraftPage>;

/** Each key present replaces what extraction found; `null` removes the edit (back to what was found). `items` replaces the whole list. */
export const UpdateDraftBody = z
  .object({
    customerName: z.string().trim().min(1).max(100).nullable().optional(),
    phone: z.string().trim().min(1).max(30).nullable().optional(),
    address: z.string().trim().min(1).max(300).nullable().optional(),
    district: z.string().trim().min(1).max(100).nullable().optional(),
    area: z.string().trim().min(1).max(100).nullable().optional(),
    postalCode: z
      .string()
      .trim()
      .regex(/^\d{4}$/, 'Postal code is 4 digits')
      .nullable()
      .optional(),
    note: z.string().trim().min(1).max(1000).nullable().optional(),
    codAmountMinor: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
    items: z
      .array(
        z.object({
          variantId: Uuid.nullable().optional(),
          text: z.string().trim().min(1).max(300),
          quantity: z.number().int().min(1).max(10_000),
        }),
      )
      .max(50)
      .optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateDraftBody = z.infer<typeof UpdateDraftBody>;

/** The same body as creating an order by hand (the reviewer completes and corrects it), including its idempotency key. */
export const ConfirmDraftBody = CreateOrderBody;
export type ConfirmDraftBody = z.input<typeof ConfirmDraftBody>;
export const ConfirmDraftResult = z.object({ draft: SocialDraft, order: OrderDetail });
export type ConfirmDraftResult = z.infer<typeof ConfirmDraftResult>;

export const DismissDraftBody = z
  .object({ reason: z.string().trim().min(1).max(200).optional() })
  .strict();
export type DismissDraftBody = z.infer<typeof DismissDraftBody>;
