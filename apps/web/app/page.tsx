import { createApiClient } from '@orderloop/api-client';
import { env } from '@/lib/env';

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

export default async function DevelopmentPage() {
  const result = await checkApi();

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 p-8">
      <div>
        <p className="inline-block rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-amber-900">
          Development build - not a product screen
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">OrderLoop</h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          Foundation only. No authentication or business features exist yet.
        </p>
      </div>

      <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
        <h2 className="text-sm font-semibold">Backend connectivity</h2>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-zinc-500">API URL</dt>
          <dd className="font-mono">{env.API_URL}</dd>
          <dt className="text-zinc-500">Environment</dt>
          <dd className="font-mono">{env.APP_ENV}</dd>
          {result.ok ? (
            <>
              <dt className="text-zinc-500">Status</dt>
              <dd className="font-mono">{result.ready.status}</dd>
              <dt className="text-zinc-500">PostgreSQL</dt>
              <dd className="font-mono">{result.ready.checks.postgres}</dd>
              <dt className="text-zinc-500">Redis</dt>
              <dd className="font-mono">{result.ready.checks.redis}</dd>
            </>
          ) : (
            <>
              <dt className="text-zinc-500">Status</dt>
              <dd className="font-mono">unreachable</dd>
              <dt className="text-zinc-500">Detail</dt>
              <dd className="font-mono break-words">{result.message}</dd>
            </>
          )}
        </dl>
      </section>
    </main>
  );
}
