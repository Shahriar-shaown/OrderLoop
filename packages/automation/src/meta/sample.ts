import { hubSignature } from './signature.js';

/**
 * Synthetic webhook notifications in the shape Meta documents, and a helper that signs and posts one. Used by the tests, by
 * `pnpm meta:demo` and by the docs: the same bytes a real delivery would carry, signed with the app secret you give it.
 */
export interface SampleMessage {
  /** The customer's id (PSID / IGSID). */
  senderId: string;
  mid: string;
  text?: string;
  attachmentTypes?: string[];
  /** Epoch ms. */
  timestamp?: number;
}

export function sampleNotification(
  object: 'page' | 'instagram',
  accountId: string,
  messages: readonly SampleMessage[],
): Record<string, unknown> {
  return {
    object,
    entry: [
      {
        id: accountId,
        time: Date.now(),
        messaging: messages.map((m) => ({
          sender: { id: m.senderId },
          recipient: { id: accountId },
          timestamp: m.timestamp ?? Date.now(),
          message: {
            mid: m.mid,
            ...(m.text !== undefined ? { text: m.text } : {}),
            ...(m.attachmentTypes
              ? { attachments: m.attachmentTypes.map((type) => ({ type, payload: {} })) }
              : {}),
          },
        })),
      },
    ],
  };
}

/** The exact body bytes and the header a delivery carries. */
export function signedWebhook(payload: unknown, appSecret: string, escaped = false) {
  const body = JSON.stringify(payload);
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': hubSignature(body, appSecret, escaped),
    },
  };
}

/** POST a signed sample to a running API (`https://.../v1/webhooks/meta`). Returns the status and the answer. */
export async function postSignedWebhook(
  url: string,
  payload: unknown,
  appSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; body: string }> {
  const { body, headers } = signedWebhook(payload, appSecret);
  const res = await fetchImpl(url, { method: 'POST', headers, body });
  return { status: res.status, body: await res.text() };
}
