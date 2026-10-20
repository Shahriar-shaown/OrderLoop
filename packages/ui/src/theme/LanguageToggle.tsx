import { SegmentedControl, type Segment } from '../inputs/SegmentedControl';
import { LOCALES, LOCALE_NAMES, useLocale, type Locale } from '../i18n';

// A language is always written in itself, so a person can find theirs whatever the app currently shows.
const SEGMENTS: Segment<Locale>[] = LOCALES.map((l) => ({ value: l, label: LOCALE_NAMES[l] }));

/** Switches the language of the app (English or Bangla). The choice is remembered by the app's `LocaleStore`. */
export function LanguageToggle() {
  const { locale, setLocale } = useLocale();
  return (
    <SegmentedControl label="Language" segments={SEGMENTS} value={locale} onChange={setLocale} />
  );
}
