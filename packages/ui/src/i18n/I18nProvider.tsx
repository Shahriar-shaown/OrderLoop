import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { localizeDigits } from './dateText';
import type { Locale } from './locales';
import { translate } from './translate';

/** Where the person's language is kept between launches (the web app: the browser; the mobile app: the device). */
export interface LocaleStore {
  get(): Promise<Locale | null>;
  set(locale: Locale): Promise<void>;
}

interface I18n {
  locale: Locale;
  setLocale(locale: Locale): void;
  t(text: string, params?: Record<string, string | number>): string;
}

/** Without a provider (tests, and apps that do not translate) everything stays English. */
const I18nContext = createContext<I18n>({
  locale: 'en',
  setLocale: () => undefined,
  t: (text, params) => translate('en', text, params),
});

/**
 * Holds the chosen language. It starts from `initial` (the phone's language, or the business's default), is replaced by
 * what `store` remembers, and writes every change back to `store`.
 */
export function I18nProvider({
  children,
  initial = 'en',
  store,
}: {
  children: ReactNode;
  initial?: Locale;
  store?: LocaleStore;
}) {
  const [locale, setLocaleState] = useState<Locale>(initial);

  useEffect(() => {
    let current = true;
    store
      ?.get()
      .then((saved) => {
        if (current && saved) setLocaleState(saved);
      })
      .catch(() => undefined); // an unreadable store just means "no saved choice"
    return () => {
      current = false;
    };
  }, [store]);

  const setLocale = useCallback(
    (next: Locale) => {
      setLocaleState(next);
      store?.set(next).catch(() => undefined);
    },
    [store],
  );

  const value = useMemo<I18n>(
    () => ({ locale, setLocale, t: (text, params) => translate(locale, text, params) }),
    [locale, setLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export const useLocale = () => useContext(I18nContext);
export const useT = () => useContext(I18nContext).t;

/** Translate whatever a `Text` was given: a string, a number, or a list of strings and elements. */
export function localizeChildren(locale: Locale, children: ReactNode): ReactNode {
  if (locale === 'en') return children;
  if (typeof children === 'string') return translate(locale, children);
  if (typeof children === 'number') return localizeDigits(String(children));
  if (Array.isArray(children)) {
    const onlyText = children.every((c) => typeof c === 'string' || typeof c === 'number');
    if (onlyText) return translate(locale, children.join(''));
    return children.map((c) => (typeof c === 'string' ? translate(locale, c) : c));
  }
  return children;
}
