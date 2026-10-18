import type { RefreshTokenStore } from '@orderloop/features';
import * as SecureStore from 'expo-secure-store';

const KEY = 'orderloop.refresh-token';

/**
 * The refresh token lives in the device's secure storage (Keychain on iOS, Keystore on Android), never in plain
 * storage. The short-lived access token stays in memory only, as on the web.
 */
export const secureTokenStore: RefreshTokenStore = {
  get: () => SecureStore.getItemAsync(KEY),
  set: (token) =>
    token === null ? SecureStore.deleteItemAsync(KEY) : SecureStore.setItemAsync(KEY, token),
};
