import { createRuntime } from '@orderloop/features';
import { env } from './env';
import { secureTokenStore } from './secureTokenStore';

/**
 * No `x-client` header is sent, so the API returns the refresh token in the response body and accepts it back in the
 * request body; `secureTokenStore` keeps it on the device.
 */
export const runtime = createRuntime({
  baseUrl: env.API_URL,
  refreshTokenStore: secureTokenStore,
  home: '/orders',
});
