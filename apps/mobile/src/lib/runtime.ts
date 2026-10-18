import { createRuntime, type RefreshTokenStore } from '@orderloop/features';
import * as SecureStore from 'expo-secure-store';
import { env } from './env';

const KEY = 'orderloop.refresh-token';

/**
 * The refresh token lives in the device's secure storage (Keychain on iOS, Keystore on Android), never in plain
 * storage. The short-lived access token stays in memory only, as on the web. No `x-client` header is sent, so the API
 * returns the refresh token in the response body and accepts it back in the request body.
 */
const refreshTokenStore: RefreshTokenStore = {
  get: () => SecureStore.getItemAsync(KEY),
  set: (token) =>
    token === null ? SecureStore.deleteItemAsync(KEY) : SecureStore.setItemAsync(KEY, token),
};

export const runtime = createRuntime({
  baseUrl: env.API_URL,
  refreshTokenStore,
  home: '/workspaces',
});
