import {
  LiveResponse,
  ReadyResponse,
  type LiveResponse as LiveResponseType,
  type ReadyResponse as ReadyResponseType,
} from '@orderloop/contracts';

export interface ApiClientOptions {
  /** API origin, e.g. http://localhost:4000 (no trailing path). */
  baseUrl: string;
  /** Injectable for tests and non-standard runtimes. Defaults to global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface Parser<T> {
  parse(data: unknown): T;
}

export function createApiClient(options: ApiClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;

  async function get<T>(path: string, schema: Parser<T>, okStatuses: number[] = [200]): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw new ApiError(
        `API unreachable at ${baseUrl}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (!okStatuses.includes(res.status))
      throw new ApiError(`Unexpected status ${res.status} from ${path}`, res.status);
    try {
      return schema.parse(await res.json());
    } catch {
      throw new ApiError(`Invalid response body from ${path}`, res.status);
    }
  }

  return {
    health: {
      live: (): Promise<LiveResponseType> => get('/health/live', LiveResponse),
      /** 503 is a valid "degraded" answer and is returned, not thrown. */
      ready: (): Promise<ReadyResponseType> => get('/health/ready', ReadyResponse, [200, 503]),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
