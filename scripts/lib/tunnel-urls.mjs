// The addresses Meta and TikTok must be given, worked out from the public HTTPS address of the API. Pure functions: no network.

/** `https://abc.ngrok-free.app` (or a bare host) to a clean https origin, or throws a message that says what is wrong. */
export function publicOrigin(input) {
  const raw = String(input ?? '').trim();
  if (raw === '')
    throw new Error(
      'give the public address of the API, for example https://my-name.ngrok-free.app',
    );
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error(`"${raw}" is not an address`);
  }
  if (url.protocol !== 'https:')
    throw new Error('the address must be https: Meta and TikTok refuse plain http');
  if (/^(localhost|127\.|0\.0\.0\.0|\[?::1)/i.test(url.hostname)) {
    throw new Error(
      'localhost cannot be reached by Meta or TikTok: use the address the tunnel prints',
    );
  }
  if (url.pathname !== '/' && url.pathname !== '')
    throw new Error('give only the address, without a path');
  if (url.port)
    throw new Error(
      'TikTok refuses a custom port in a webhook address: use the tunnel or domain on 443',
    );
  return url.origin;
}

/** Everything to paste into the Meta and TikTok dashboards and into the environment, for one public API origin. */
export function urlsFor(input, { webAppUrl = 'http://localhost:3000' } = {}) {
  const api = publicOrigin(input);
  return {
    api,
    env: [
      `API_PUBLIC_URL=${api}`,
      `WEB_APP_URL=${webAppUrl}`,
      'META_MODE=live',
      'TIKTOK_MODE=live',
    ],
    meta: {
      oauthRedirectUri: `${api}/v1/integrations/meta/oauth/callback`,
      webhookCallbackUrl: `${api}/v1/webhooks/meta`,
      deauthorizeCallbackUrl: `${api}/v1/webhooks/meta/deauthorize`,
      dataDeletionCallbackUrl: `${api}/v1/webhooks/meta/data-deletion`,
    },
    tiktok: {
      redirectUrl: `${api}/v1/integrations/tiktok-shop/oauth/callback`,
      webhookUrl: `${api}/v1/webhooks/tiktok-shop`,
    },
  };
}

/** The first https tunnel address found in a line of tunnel output (ngrok, cloudflared quick tunnels), or null. */
export function tunnelUrlFrom(text) {
  const found = String(text).match(
    /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:ngrok-free\.app|ngrok-free\.dev|ngrok\.app|ngrok\.dev|ngrok\.io|trycloudflare\.com)\b/i,
  );
  return found ? found[0].toLowerCase() : null;
}

/**
 * The value of one variable from the text of a `.env` file, or undefined. Only the variable asked for is read, so nothing else in
 * the file (secrets) is touched. Handles `KEY=value`, quotes and trailing comments; ignores commented-out lines.
 */
export function envValue(envText, key) {
  for (const line of String(envText).split(/\r?\n/)) {
    const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`));
    if (!m) continue;
    let v = m[1].trim();
    if (/^(["']).*\1/.test(v)) v = v.slice(1, v.indexOf(v[0], 1));
    else v = v.replace(/\s+#.*$/, '');
    return v === '' ? undefined : v;
  }
  return undefined;
}
