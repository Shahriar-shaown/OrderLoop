import assert from 'node:assert/strict';
import { test } from 'node:test';
import { envValue, publicOrigin, tunnelUrlFrom, urlsFor } from './lib/tunnel-urls.mjs';

test('a tunnel address becomes the exact URLs the dashboards need', () => {
  const u = urlsFor('https://my-shop.ngrok-free.app/');
  assert.equal(u.api, 'https://my-shop.ngrok-free.app');
  assert.equal(
    u.meta.oauthRedirectUri,
    'https://my-shop.ngrok-free.app/v1/integrations/meta/oauth/callback',
  );
  assert.equal(u.meta.webhookCallbackUrl, 'https://my-shop.ngrok-free.app/v1/webhooks/meta');
  assert.equal(
    u.meta.deauthorizeCallbackUrl,
    'https://my-shop.ngrok-free.app/v1/webhooks/meta/deauthorize',
  );
  assert.equal(
    u.meta.dataDeletionCallbackUrl,
    'https://my-shop.ngrok-free.app/v1/webhooks/meta/data-deletion',
  );
  assert.equal(
    u.tiktok.redirectUrl,
    'https://my-shop.ngrok-free.app/v1/integrations/tiktok-shop/oauth/callback',
  );
  assert.equal(u.tiktok.webhookUrl, 'https://my-shop.ngrok-free.app/v1/webhooks/tiktok-shop');
  assert.ok(u.env.includes('API_PUBLIC_URL=https://my-shop.ngrok-free.app'));
});

test('a bare host is accepted and made https', () => {
  assert.equal(publicOrigin('api.example.com'), 'https://api.example.com');
});

test('addresses Meta or TikTok would refuse are rejected with a reason', () => {
  assert.throws(() => publicOrigin(''), /public address/);
  assert.throws(() => publicOrigin('http://x.ngrok-free.app'), /https/);
  assert.throws(() => publicOrigin('https://localhost:4000'), /localhost/);
  assert.throws(() => publicOrigin('https://127.0.0.1'), /localhost/);
  assert.throws(() => publicOrigin('https://x.example.com/v1'), /without a path/);
  assert.throws(() => publicOrigin('https://x.example.com:8443'), /port/);
});

test('the tunnel address is found in ngrok and cloudflared output', () => {
  assert.equal(
    tunnelUrlFrom('Forwarding  https://Abc-12.ngrok-free.app -> http://localhost:4000'),
    'https://abc-12.ngrok-free.app',
  );
  assert.equal(
    tunnelUrlFrom('|  https://random-words-here.trycloudflare.com  |'),
    'https://random-words-here.trycloudflare.com',
  );
  assert.equal(
    tunnelUrlFrom('Forwarding https://calm-fox-123.ngrok-free.dev -> http://localhost:4000'),
    'https://calm-fox-123.ngrok-free.dev',
  );
  assert.equal(tunnelUrlFrom('no address in this line'), null);
});

test('NGROK_DOMAIN is read from .env text, and only that variable is looked at', () => {
  const text = [
    '# NGROK_DOMAIN=commented-out.ngrok-free.app',
    'JWT_PRIVATE_KEY=secret-that-must-not-matter',
    'API_PUBLIC_URL=https://x.ngrok-free.dev',
    'NGROK_DOMAIN=unrepressive-pesteringly-allyn.ngrok-free.dev',
  ].join('\n');
  assert.equal(envValue(text, 'NGROK_DOMAIN'), 'unrepressive-pesteringly-allyn.ngrok-free.dev');
  assert.equal(
    envValue('NGROK_DOMAIN="quoted.ngrok-free.dev"  # note', 'NGROK_DOMAIN'),
    'quoted.ngrok-free.dev',
  );
  assert.equal(
    envValue('NGROK_DOMAIN=plain.ngrok-free.dev # note', 'NGROK_DOMAIN'),
    'plain.ngrok-free.dev',
  );
  assert.equal(envValue('# NGROK_DOMAIN=only-a-comment', 'NGROK_DOMAIN'), undefined);
  assert.equal(envValue('NGROK_DOMAIN=', 'NGROK_DOMAIN'), undefined);
  assert.equal(envValue('OTHER=1', 'NGROK_DOMAIN'), undefined);
});
