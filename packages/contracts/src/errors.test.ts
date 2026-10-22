import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ERROR_STATUS, KNOWN_ERROR_CODES, Problem, type ErrorCode } from './errors.js';

describe('Problem', () => {
  const base = { type: 'about:blank', title: 'Nope', status: 409, detail: 'Try again' };
  it('keeps a problem whose code this build does not know, so message and status survive', () => {
    const parsed = Problem.safeParse({ ...base, code: 'brand_new_code' });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ code: 'brand_new_code', detail: 'Try again', status: 409 });
  });
  it('has exactly one status for every known code', () => {
    expect(Object.keys(ERROR_STATUS).sort()).toEqual([...KNOWN_ERROR_CODES].sort());
  });
});

/** What each code means, in the words of docs/api.md. A new code does not compile until it is described here. */
const MEANING: Record<ErrorCode, string> = {
  validation_failed:
    'Body, query or path failed validation. See `errors`. An oversized or unreadable JSON body is also this code, with 413 or 415.',
  invitation_invalid:
    'Invitation unknown, used, expired, revoked, or its inviter lost the authority to grant it.',
  token_invalid:
    'Verification or reset link unknown, used, expired, or for another purpose. Deliberately uniform.',
  unauthorized:
    'Missing, malformed or invalid access token, or the session/membership/account is no longer valid.',
  token_expired: 'Access token expired (refresh it), or the refresh session has ended.',
  invalid_credentials:
    'Wrong email or password. Same answer for unknown email, disabled account and wrong password.',
  token_reuse_detected: 'A used refresh token was presented again. The session is revoked.',
  forbidden: 'Authenticated, but your role lacks the permission.',
  email_not_verified: 'Verify your email address first (currently required to invite people).',
  registration_closed:
    'Sign-up is closed on this server (pilot): the email is not on the invite list. Ask the operator. Invitations to a business still work.',
  not_found:
    'Resource does not exist **or belongs to another tenant** (the two are indistinguishable).',
  conflict: 'For example the email is already registered, or the person is already a member.',
  tenant_changed:
    'A refresh sent `expectedTenantId`, but its session belongs to another business (a second tab switched). Nothing rotated.',
  last_owner: 'The change would leave a tenant without an owner.',
  insufficient_stock:
    'Not enough available stock for a reservation, an adjustment or an order. `detail` says how many are available.',
  invalid_transition: 'The order cannot move from its current status to the requested one.',
  version_conflict: 'The record changed since you read it (`ifVersion` no longer matches).',
  idempotency_conflict: 'The idempotency key was already used with a different request.',
  courier_not_configured:
    'The courier is not connected, not enabled, or its credentials are missing.',
  shipment_conflict: 'A live shipment (or a booking in progress) blocks this change.',
  settlement_has_issues: 'The settlement still has unmatched lines or open discrepancies.',
  courier_rejected:
    'The courier refused the credentials, the booking or the cancellation. `detail` says why.',
  courier_unsupported:
    'The courier cannot do this through its API (for example cancel, or look up by reference).',
  channel_not_configured:
    'The server has no provider for that channel (sms or whatsapp), so a rule cannot use it and nobody can consent to it.',
  consent_required:
    'Nobody who would receive this has agreed to the channel (sms or whatsapp) yet, so it cannot be switched on.',
  meta_not_configured:
    'The Meta integration is not set up on this server (live mode needs the META_* settings), or the action needs a mode this server is not in.',
  meta_oauth_invalid:
    'The Meta sign-in link or hand-over is unknown, expired (10 minutes), already used, or was started by someone else. Start again.',
  meta_permission_denied:
    'Meta refused: the person did not grant a required permission, or has no admin task on that Page. `detail` names what to fix.',
  meta_instagram_not_linked:
    'The Page has no Instagram professional account linked, so an Instagram connection is not possible.',
  meta_messages_access_off:
    'Instagram message access is off. In the Instagram app turn on Allow Access to Messages (Message controls > Connected tools).',
  meta_token_invalid:
    'Meta no longer accepts the saved access (password change, removed app, expired). Reconnect the account.',
  meta_unavailable:
    'Meta could not be reached, is limiting requests, or answered badly. Try again shortly.',
  tiktok_not_configured:
    'The TikTok Shop integration is not set up on this server (live mode needs the TIKTOK_* settings), or the action needs a mode this server is not in.',
  tiktok_oauth_invalid:
    'The TikTok sign-in link or hand-over is unknown, expired (10 minutes), already used, or was started by someone else. Start again.',
  tiktok_permission_denied:
    'TikTok refused: the seller did not grant a required permission, or the app is not approved for that shop. `detail` names what to fix.',
  tiktok_token_invalid:
    'TikTok no longer accepts the saved access (expired, revoked, or the seller removed the app). Reconnect the shop.',
  tiktok_unavailable:
    'TikTok could not be reached, is limiting requests, or answered badly. Try again shortly.',
  draft_closed: 'The draft was already confirmed or dismissed, so it can no longer be changed.',
  erase_blocked:
    'The customer still has orders in progress (not delivered, cancelled or returned). Finish or cancel them first; `detail` says how many.',
  account_delete_blocked:
    'The person is the only owner of a business that has other members. Transfer ownership or remove the members first; `detail` names the businesses.',
  tenant_deleted:
    'The business is scheduled for deletion, so nothing in it can be used. Only its owner can cancel, within the grace period (`GET /v1/tenant/deletion-status`).',
  rate_limited:
    'Too many requests, failed sign-ins, or a per-business budget (imports, exports, invitations). See `Retry-After`.',
  internal_error: 'Unexpected. Quote the `x-request-id`.',
  courier_unavailable: 'The courier could not be reached or answered badly. Try again shortly.',
  service_unavailable:
    'A dependency of ours (the job queue) is down. Nothing was lost; try again shortly.',
};

const START = '<!-- error-table:start (generated by packages/contracts/src/errors.test.ts) -->';
const END = '<!-- error-table:end -->';

/** The markdown table, padded the way prettier formats it so the file stays stable. */
function errorTable(): string {
  const rows = [...KNOWN_ERROR_CODES]
    .sort(
      (a, b) =>
        ERROR_STATUS[a] - ERROR_STATUS[b] ||
        KNOWN_ERROR_CODES.indexOf(a) - KNOWN_ERROR_CODES.indexOf(b),
    )
    .map((code) => [`\`${code}\``, String(ERROR_STATUS[code]), MEANING[code]] as const);
  const head = ['`code`', 'Status', 'Meaning'] as const;
  const widths = [0, 1, 2].map((i) => Math.max(head[i]!.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: readonly string[]) =>
    `| ${cells.map((c, i) => c.padEnd(widths[i]!)).join(' | ')} |`;
  return [line(head), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

describe('docs/api.md error table', () => {
  const file = new URL('../../../docs/api.md', import.meta.url);
  const expected = `${START}\n\n${errorTable()}\n\n${END}`;

  it('lists every code with its one status (regenerate with UPDATE_DOCS=1 pnpm --filter @orderloop/contracts test)', () => {
    const doc = readFileSync(file, 'utf8');
    const a = doc.indexOf(START);
    const b = doc.indexOf(END);
    expect(a, 'start marker missing in docs/api.md').toBeGreaterThanOrEqual(0);
    if (process.env['UPDATE_DOCS'])
      writeFileSync(file, doc.slice(0, a) + expected + doc.slice(b + END.length));
    else expect(doc.slice(a, b + END.length)).toBe(expected);
  });
});
