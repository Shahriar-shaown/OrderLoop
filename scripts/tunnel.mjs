#!/usr/bin/env node
// Opens a public HTTPS tunnel to the local API, so Meta and TikTok can reach its sign-in callbacks and webhooks, and prints the
// exact addresses to register. Only the API needs to be public: the web app can stay on http://localhost:3000.
//
//   pnpm tunnel                              ngrok if it is installed, else a temporary Cloudflare quick tunnel
//   pnpm tunnel --domain my-name.ngrok-free.app     use your free ngrok dev domain (stable: needed for Meta and TikTok)
//   pnpm tunnel --tool cloudflared           force the tool (quick tunnel: the address CHANGES every run)
//   pnpm tunnel --print https://api.example.com     do not start anything: just print the addresses for a server you already have
//
// Options: --port 4000 (the API), --web http://localhost:3000 (where the sign-in returns to).
// NGROK_DOMAIN (shell environment or the repository's .env) is used when --domain is not given. Installs nothing, stores nothing.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envValue, publicOrigin, tunnelUrlFrom, urlsFor } from './lib/tunnel-urls.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const port = flag('port') ?? '4000';
const web = flag('web') ?? 'http://localhost:3000';
// The domain comes from --domain, the shell environment, or NGROK_DOMAIN in the repository's .env (pnpm does not load .env itself).
const envFile = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
const domain =
  flag('domain') ??
  process.env.NGROK_DOMAIN ??
  (existsSync(envFile) ? envValue(readFileSync(envFile, 'utf8'), 'NGROK_DOMAIN') : undefined);
const printOnly = flag('print');

const have = (cmd) => spawnSync('which', [cmd], { encoding: 'utf8' }).status === 0;

function report(origin, { temporary = false } = {}) {
  const u = urlsFor(origin, { webAppUrl: web });
  const line = (label, value) => console.log(`  ${label.padEnd(34)} ${value}`);
  console.log(
    `\nPublic address of the API: ${u.api}${temporary ? '   (TEMPORARY: it changes every run)' : ''}\n`,
  );
  console.log('1) Put this in .env (API and worker read it), then restart both:');
  for (const l of u.env) console.log(`     ${l}`);
  console.log(
    '   plus the Meta / TikTok secrets from their dashboards (see docs/operations/free-deployment.md).\n',
  );
  console.log('2) Meta (developers.facebook.com):');
  line('Valid OAuth redirect URI', u.meta.oauthRedirectUri);
  line('Webhook callback URL', u.meta.webhookCallbackUrl);
  line('Deauthorize callback URL', u.meta.deauthorizeCallbackUrl);
  line('Data deletion callback URL', u.meta.dataDeletionCallbackUrl);
  console.log('\n3) TikTok Shop (Partner Center):');
  line('Redirect URL', u.tiktok.redirectUrl);
  line('Webhook URL', u.tiktok.webhookUrl);
  if (temporary) {
    console.log(
      '\n   A quick tunnel gets a NEW address each time. Meta and TikTok keep the address you registered, so use it only to',
    );
    console.log(
      '   look around. For real tests use a stable address: an ngrok dev domain (free) or a Cloudflare named tunnel (needs a domain).',
    );
  }
  console.log('\nLeave this running while you test. Ctrl-C closes the tunnel.\n');
}

if (printOnly) {
  try {
    report(printOnly);
    process.exit(0);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(2);
  }
}

const tool = flag('tool') ?? (have('ngrok') ? 'ngrok' : have('cloudflared') ? 'cloudflared' : null);
if (!tool) {
  console.error(`No tunnel tool is installed. Install one (nothing is installed for you):

  ngrok (free account; gives you one stable dev domain):
      brew install ngrok/ngrok/ngrok
      ngrok config add-authtoken <your token from dashboard.ngrok.com>
      then find your free dev domain at dashboard.ngrok.com > Domains and run:
      pnpm tunnel --domain <that-domain>

  cloudflared (no account for a quick tunnel, but its address changes every run):
      brew install cloudflared
      pnpm tunnel --tool cloudflared

Already have a public server? Just print the addresses: pnpm tunnel --print https://api.your-domain.com`);
  process.exit(2);
}
if (!have(tool)) {
  console.error(
    `${tool} is not installed (try: brew install ${tool === 'ngrok' ? 'ngrok/ngrok/ngrok' : tool})`,
  );
  process.exit(2);
}

let child;
let shown = false;
const show = (origin, opts) => {
  if (shown) return;
  shown = true;
  try {
    report(origin, opts);
  } catch (e) {
    console.error(`error: ${e.message}`);
  }
};

if (tool === 'ngrok') {
  let target = null;
  if (domain) {
    try {
      target = new URL(publicOrigin(domain)).host;
    } catch (e) {
      console.error(`error: ${e.message}`);
      process.exit(2);
    }
  }
  child = spawn(
    'ngrok',
    [
      'http',
      ...(target ? [`--url=https://${target}`] : []),
      port,
      '--log=stdout',
      '--log-format=logfmt',
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (target) show(`https://${target}`);
  const onData = (d) => {
    const found = tunnelUrlFrom(String(d));
    if (found) show(found, { temporary: !target });
    if (/ERR_NGROK|authentication failed|authtoken/i.test(String(d)))
      process.stderr.write(String(d));
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
} else {
  const token = process.env.CLOUDFLARE_TUNNEL_TOKEN;
  if (token) {
    if (!domain) {
      console.error(
        'a named Cloudflare tunnel needs --domain <the hostname you routed to it in the Cloudflare dashboard>',
      );
      process.exit(2);
    }
    // The token goes in the environment (TUNNEL_TOKEN), not on the command line, where any user on this machine could read it.
    child = spawn('cloudflared', ['tunnel', 'run'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, TUNNEL_TOKEN: token },
    });
    show(`https://${domain}`);
  } else {
    child = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onData = (d) => {
      const found = tunnelUrlFrom(String(d));
      if (found) show(found, { temporary: true });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  }
}

child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
