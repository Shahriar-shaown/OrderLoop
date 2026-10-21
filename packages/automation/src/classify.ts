/**
 * Sending can fail in two ways that need different treatment:
 *  - transient: the network, a timeout, the provider's 5xx or 429. Trying again later can work, so the job is retried with back-off.
 *  - permanent: the recipient or request is wrong (a dead token, no consent, a refused address). Trying again cannot work, so the
 *    delivery is recorded and the job ends without retries.
 */
export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    /** A short stable reason shown in the failed-deliveries list (`invalid_recipient`, `provider_unavailable`...). */
    readonly reason: string,
  ) {
    super(message);
    this.name = 'DeliveryError';
  }
}

export type ErrorClass = { permanent: boolean; reason: string };

/** Decide whether an error from a provider is worth retrying. Unknown errors are retried: a lost send is worse than a late one. */
export function classifyError(error: unknown): ErrorClass {
  if (error instanceof DeliveryError) return { permanent: error.permanent, reason: error.reason };
  const e = error as {
    responseCode?: number;
    code?: string;
    status?: number;
    name?: string;
  } | null;
  // SMTP: 5xx is the server saying no (bad mailbox, rejected content); 4xx is "try again later".
  if (typeof e?.responseCode === 'number') {
    return e.responseCode >= 500 && e.responseCode < 600
      ? { permanent: true, reason: 'invalid_recipient' }
      : { permanent: false, reason: 'provider_unavailable' };
  }
  // HTTP: 4xx is our request being wrong, except "request timeout" and "too many requests".
  if (typeof e?.status === 'number') {
    const s = e.status;
    if (s === 408 || s === 429) return { permanent: false, reason: 'rate_limited' };
    if (s >= 400 && s < 500) return { permanent: true, reason: 'rejected' };
    return { permanent: false, reason: 'provider_unavailable' };
  }
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError' || e?.code === 'ETIMEDOUT')
    return { permanent: false, reason: 'timeout' };
  return { permanent: false, reason: 'error' };
}

/**
 * What is stored in `last_error` and in logs: a short reason plus the error class, with anything that looks like an email
 * address, a push token, a phone number or a long secret removed, and cut to 200 characters.
 */
export function scrubError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return raw
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/ExponentPushToken\[[^\]]*\]/g, '[token]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[number]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[secret]')
    .slice(0, 200);
}
