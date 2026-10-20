import { SegmentedControl } from '../inputs/SegmentedControl';
import { LOCALES, LOCALE_NAMES, useLocale, type Locale } from '../i18n';
import { SelectMenu } from '../overlays/SelectMenu';

// A language is always written in itself, so a person can find theirs whatever the app currently shows.
const OPTIONS = LOCALES.map((l) => ({ value: l, label: LOCALE_NAMES[l] }));

/** Switches the language of the app (English or Bangla), as a row of choices. Remembered by the app's `LocaleStore`. */
export function LanguageToggle() {
  const { locale, setLocale } = useLocale();
  return (
    <SegmentedControl<Locale>
      label="Language"
      segments={OPTIONS}
      value={locale}
      onChange={setLocale}
    />
  );
}

/** The same choice as a compact dropdown, for a corner of a screen. */
export function LanguageSelect() {
  const { locale, setLocale } = useLocale();
  return (
    <SelectMenu<Locale> label="Language" options={OPTIONS} value={locale} onChange={setLocale} />
  );
}
