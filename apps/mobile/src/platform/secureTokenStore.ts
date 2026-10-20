import AsyncStorage from '@react-native-async-storage/async-storage';
import type { RefreshTokenStore } from '@orderloop/features';
import * as SecureStore from 'expo-secure-store';

const KEY = 'orderloop.refresh-token';
const INSTALL_MARKER = 'orderloop.installed';

/** Stays on this phone: not included in backups and not restored onto another device. */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/**
 * The iOS keychain survives uninstalling the app, so a fresh install could find the previous install's token. The marker
 * lives in the app's own storage (which an uninstall does remove): no marker means a fresh install, so any token is stale.
 */
async function forgetTokenOfEarlierInstall(): Promise<void> {
  if (await AsyncStorage.getItem(INSTALL_MARKER)) return;
  await SecureStore.deleteItemAsync(KEY, OPTIONS);
  await AsyncStorage.setItem(INSTALL_MARKER, '1');
}

/**
 * The refresh token lives in the device's secure storage (Keychain on iOS, Keystore on Android), never in plain
 * storage. The short-lived access token stays in memory only, as on the web.
 */
export const secureTokenStore: RefreshTokenStore = {
  get: async () => {
    await forgetTokenOfEarlierInstall();
    return SecureStore.getItemAsync(KEY, OPTIONS);
  },
  set: (token) =>
    token === null
      ? SecureStore.deleteItemAsync(KEY, OPTIONS)
      : SecureStore.setItemAsync(KEY, token, OPTIONS),
};
