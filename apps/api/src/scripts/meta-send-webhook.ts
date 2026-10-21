// Send a correctly signed synthetic Meta webhook to a local API, the way Meta would. For trying the real webhook route by hand and for
// the docs. Needs META_APP_SECRET (the same value the API runs with).
// Run: pnpm meta:send-webhook --account <page-or-instagram-id> [--object page|instagram] [--sender PSID1] [--text "..."] [--mid ...] [--url http://localhost:4000]
import { postSignedWebhook, sampleNotification } from '@orderloop/automation';
import { loadDotEnv, loadServerEnv } from '@orderloop/contracts/server';
import { randomUUID } from 'node:crypto';

loadDotEnv();
const env = loadServerEnv();
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const account = arg('account');
const secret = env.META_APP_SECRET;
if (!account || !secret) {
  console.error(
    'Usage: pnpm meta:send-webhook --account <id> [--text "..."]  (and META_APP_SECRET must be set)',
  );
  process.exit(1);
}
const url = `${arg('url', `http://localhost:${env.API_PORT}`)!.replace(/\/+$/, '')}/v1/webhooks/meta`;
const object = arg('object', 'page') === 'instagram' ? 'instagram' : 'page';
const payload = sampleNotification(object, account, [
  {
    senderId: arg('sender', 'sample-customer-1')!,
    mid: arg('mid', `sample_${randomUUID()}`)!,
    text: arg('text', 'অর্ডার করব, ০১৭১২৩৪৫৬৭৮, বাসা ৫ রোড ৩ ঢাকা')!,
  },
]);
const r = await postSignedWebhook(url, payload, secret);
console.log(`POST ${url} -> ${r.status} ${r.body}`);
process.exit(r.status === 200 ? 0 : 1);
