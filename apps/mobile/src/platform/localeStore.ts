import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Locale, LocaleStore } from '@orderloop/ui';
import { getLocales } from 'expo-localization';

const KEY = 'orderloop.language';

/** The chosen language, kept on the device (not a secret, so plain storage). */
export const localeStore: LocaleStore = {
  get: async () => {
    const saved = await AsyncStorage.getItem(KEY);
    return saved === 'en' || saved === 'bn' ? saved : null;
  },
  set: (locale) => AsyncStorage.setItem(KEY, locale),
};

/** Until the person chooses: Bangla if the phone is set to Bangla, English otherwise. */
export const deviceLocale = (): Locale => (getLocales()[0]?.languageCode === 'bn' ? 'bn' : 'en');
