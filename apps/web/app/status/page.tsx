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
  // A plain server page: it reads the theme's CSS variables, so it matches the app without loading any client code.
  return (
    <main
      id="main"
      style={{ maxWidth: 560, margin: '0 auto', padding: 32, fontFamily: 'system-ui, sans-serif' }}
    >
      <h1 style={{ margin: 0 }}>System status</h1>
      <p style={{ color: 'var(--ol-muted)' }}>
        For developers.{' '}
        <a href="/login" style={{ color: 'var(--ol-primary)' }}>
          Go to sign in
        </a>
      </p>
      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: '4px 16px',
          border: '1px solid var(--ol-border)',
          borderRadius: 12,
          padding: 16,
        }}
      >
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt style={{ color: 'var(--ol-muted)' }}>{k}</dt>
            <dd
              style={{ margin: 0, fontFamily: 'ui-monospace, monospace', overflowWrap: 'anywhere' }}
            >
              {v}
            </dd>
          </div>
        ))}
      </dl>
    </main>
  );
}
