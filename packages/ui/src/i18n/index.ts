import { registerCatalog } from './catalog';
import { bn } from './bn';

registerCatalog('bn', bn);

export { missingTranslations, registerCatalog } from './catalog';
export { localizeDateText, localizeDigits, toAsciiDigits } from './dateText';
export { I18nProvider, localizeChildren, useLocale, useT, type LocaleStore } from './I18nProvider';
export { LOCALES, LOCALE_NAMES, type Locale } from './locales';
export { translate, translatedProps } from './translate';
