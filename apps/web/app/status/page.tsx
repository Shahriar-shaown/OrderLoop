import type { Metadata } from 'next';
import { createApiClient } from '@orderloop/api-client';
import { env } from '@/lib/env';

export const metadata: Metadata = { title: 'Status' };
// Always evaluate on request so the connectivity result is live.
export const dynamic = 'force-dynamic';

async function checkApi() {
  try {
    return {
      ok: true as const,
      ready: await createApiClient({ baseUrl: env.API_URL }).health.ready(),
    };
  } catch (error) {
    return {
      ok: false as const,
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/** Backend connectivity, for developers: is the API reachable and are its database and queue up? */
export default async function StatusPage() {
  const result = await checkApi();
  const rows: [string, string][] = [
    ['API URL', env.API_URL],
    ['Environment', env.APP_ENV],
    ...(result.ok
      ? ([
          ['Status', result.ready.status],
          ['PostgreSQL', result.ready.checks.postgres],
          ['Redis', result.ready.checks.redis],
        ] as [string, string][])
      : ([
          ['Status', 'unreachable'],
          ['Detail', result.message],
        ] as [string, string][])),
  ];
  const healthy = result.ok && result.ready.status === 'ok';
  const dot = (v: string) =>
    ['ok', 'up', 'connected'].includes(v.toLowerCase())
      ? 'var(--ol-tone-success-dot)'
      : ['unreachable', 'down', 'error'].includes(v.toLowerCase())
        ? 'var(--ol-tone-error-dot)'
        : undefined;
  // A plain server page: it reads the theme's CSS variables, so it matches the app without loading any client code.
  return (
    <main
      id="main"
      style={{
        maxWidth: 560,
        margin: '0 auto',
        padding: '32px 16px',
        display: 'grid',
        gap: 24,
      }}
    >
      <div>
        <h1 style={{ margin: 0, fontSize: 24, lineHeight: '32px', fontWeight: 600 }}>
          System status
        </h1>
        <p
          style={{ margin: '4px 0 0', color: 'var(--ol-muted)', fontSize: 14, lineHeight: '20px' }}
        >
          For developers.{' '}
          <a href="/login" style={{ color: 'var(--ol-primary)' }}>
            Go to sign in
          </a>
        </p>
      </div>
      <div
        role="status"
        style={{
          padding: '12px 16px',
          borderRadius: 8,
          fontSize: 14,
          lineHeight: '20px',
          border: `1px solid var(--ol-tone-${healthy ? 'success' : 'error'}-border)`,
          background: `var(--ol-tone-${healthy ? 'success' : 'error'}-background)`,
          color: `var(--ol-tone-${healthy ? 'success' : 'error'}-text)`,
        }}
      >
        {healthy
          ? 'The API, its database and its queue are reachable.'
          : 'The API is not fully available.'}
      </div>
      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: '12px 24px',
          margin: 0,
          border: '1px solid var(--ol-border)',
          borderRadius: 12,
          background: 'var(--ol-surface)',
          padding: 20,
          fontSize: 14,
          lineHeight: '20px',
        }}
      >
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt style={{ color: 'var(--ol-muted)' }}>{k}</dt>
            <dd
              style={{
                margin: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontFamily: 'ui-monospace, monospace',
                overflowWrap: 'anywhere',
              }}
            >
              {dot(v) ? (
                <span
                  aria-hidden
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    background: dot(v),
                    flexShrink: 0,
                  }}
                />
              ) : null}
              {v}
            </dd>
          </div>
        ))}
      </dl>
    </main>
  );
}
