import { createRuntime } from '@orderloop/features';
import { env } from './env';

/**
 * One API client and session per browser tab. `x-client: web` makes the API deliver the refresh token as an HttpOnly cookie
 * (never in JSON), and `credentials: 'include'` lets the browser send and store that cookie although the API is on another
 * origin.
 */
export const runtime = createRuntime({
  baseUrl: env.API_URL,
  headers: { 'x-client': 'web' },
  credentials: 'include',
});
