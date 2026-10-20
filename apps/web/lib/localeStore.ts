import type { LocaleStore } from '@orderloop/ui';

const KEY = 'orderloop.language';

/** The chosen language, kept in the browser (not a secret). A blocked or full storage just means "no saved choice". */
export const localeStore: LocaleStore = {
  get: async () => {
    try {
      const saved = localStorage.getItem(KEY);
      return saved === 'en' || saved === 'bn' ? saved : null;
    } catch {
      return null;
    }
  },
  set: async (locale) => {
    try {
      localStorage.setItem(KEY, locale);
    } catch {
      // Nothing to do: the choice still applies until the page is closed.
    }
  },
};
