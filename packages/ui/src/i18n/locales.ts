/** The languages the app is available in. Add a code here, a catalogue next to `bn.ts`, and a name below. */
export const LOCALES = ['en', 'bn'] as const;
export type Locale = (typeof LOCALES)[number];

/** Each language written in itself, so a person can always find theirs whatever the app currently shows. */
export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', bn: 'বাংলা' };
