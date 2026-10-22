import { tiktokWebhookSignature } from './signature.js';

/**
 * Synthetic TikTok Shop webhook deliveries and a helper that signs and posts one with the REAL scheme (HMAC-SHA256 of
 * app_key + raw body, keyed with the app secret, in the `Authorization` header). Used by the tests, by `pnpm tiktok:demo` and by
 * the docs: the same bytes a real delivery would carry, signed with the app key and secret you give it.
 */
export interface SampleOrderEvent {
  shopId: string;
  orderId: string;
  /** The new status the notification names (e.g. `AWAITING_SHIPMENT`). */
  status: string;
  /** Repeat it to replay the same delivery. */
  notificationId?: string;
  /** Epoch seconds. */
  timestamp?: number;
  /** TikTok's numeric type; 1 is the order status update. */
  type?: number;
}

export function sampleOrderStatusEvent(e: SampleOrderEvent): Record<string, unknown> {
  const ts = e.timestamp ?? Math.floor(Date.now() / 1000);
  return {
    type: e.type ?? 1,
    tts_notification_id: e.notificationId ?? `sample_${e.orderId}_${e.status}_${ts}`,
    shop_id: e.shopId,
    timestamp: ts,
    data: {
      is_on_hold_order: false,
      order_id: e.orderId,
      order_status: e.status,
      update_time: ts,
    },
  };
}

/** The exact body bytes and the header a delivery carries. */
export function signedTikTokWebhook(payload: unknown, appKey: string, appSecret: string) {
  const body = JSON.stringify(payload);
  return {
    body,
    headers: {
      'content-type': 'application/json',
      authorization: tiktokWebhookSignature(body, appKey, appSecret),
    },
  };
}

/** POST a signed sample to a running API (`https://.../v1/webhooks/tiktok-shop`). Returns the status and the answer (which must be empty). */
export async function postSignedTikTokWebhook(
  url: string,
  payload: unknown,
  appKey: string,
  appSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; body: string }> {
  const { body, headers } = signedTikTokWebhook(payload, appKey, appSecret);
  const res = await fetchImpl(url, { method: 'POST', headers, body });
  return { status: res.status, body: await res.text() };
}
