import { catalogFor, recordMissing, type CompiledCatalog } from './catalog';
import { localizeDateText, localizeDigits } from './dateText';
import type { Locale } from './locales';

type Params = Record<string, string | number>;

const fillIn = (text: string, params?: Params): string =>
  params
    ? text.replace(/\{(\w+)\}/g, (placeholder, name: string) => String(params[name] ?? placeholder))
    : text;

/**
 * May `value` stand in a placeholder? A pattern such as "{a} order" would otherwise swallow any text that ends in "order".
 * A number, an amount, a percentage, or text with a translation of its own always fits; a short name fits only a pattern
 * with enough fixed words around it ("{a} is now {b}") to make an accidental match unlikely.
 */
function fitsPlaceholder(catalog: CompiledCatalog, value: string, literalLength: number): boolean {
  // Numbers, amounts, percentages and e-mail addresses are data, never a sentence to be swallowed by accident.
  if (/[0-9৳%@]/.test(value) || catalog.exact.has(value.trim())) return true;
  const looksLikeAName =
    value.length <= 40 && !/[.!?:]/.test(value) && value.split(/\s+/).length <= 4;
  return literalLength >= 6 && looksLikeAName;
}

/** The translation of `text` by a pattern entry, or undefined when no pattern fits. */
function translateByPattern(
  locale: Locale,
  catalog: CompiledCatalog,
  text: string,
): string | undefined {
  for (const pattern of catalog.patterns) {
    const match = pattern.re.exec(text);
    const pieces = match?.slice(1);
    if (!pieces || !pieces.every((piece) => fitsPlaceholder(catalog, piece, pattern.literalLength)))
      continue;
    let result = pattern.target;
    pattern.names.forEach((name, i) => {
      result = result.replaceAll(`{${name}}`, translate(locale, pieces[i]!));
    });
    return localizeDateText(localizeDigits(result));
  }
  return undefined;
}

/** Text made only of digits, signs and an optional k/M suffix: a price, a count, a percentage, a time. */
const isNumeric = (text: string) => !/[A-Za-z]/.test(text.replace(/(?<=[\d.])[kKmM]$/, ''));

/**
 * `text` in a locale. English comes back unchanged. For Bangla: an exact entry, else a pattern entry, else the English
 * text (recorded by `missingTranslations()`). Text without letters gets Bengali digits; text with letters keeps its digits so
 * that order numbers and SKUs stay copyable. Dates are always localised.
 */
export function translate(locale: Locale, text: string, params?: Params): string {
  const source = fillIn(text, params);
  if (locale === 'en') return source;
  const trimmed = source.trim();
  if (!trimmed) return source;

  const catalog = catalogFor(locale);
  const exact = catalog?.exact.get(trimmed);
  if (exact !== undefined) return localizeDateText(localizeDigits(exact));

  const byPattern = catalog && translateByPattern(locale, catalog, trimmed);
  if (byPattern !== undefined) return byPattern;

  if (isNumeric(trimmed)) return localizeDigits(source);

  const withDates = localizeDateText(source);
  const onlyDatesLeft = !/[A-Za-z]{3,}/.test(withDates.replace(/AM|PM/g, ''));
  if (withDates !== source && onlyDatesLeft) return withDates;
  recordMissing(trimmed);
  return withDates;
}

const LABEL_PROPS = [
  'accessibilityLabel',
  'aria-label',
  'placeholder',
  'accessibilityHint',
] as const;

/** The props of a control that hold text for people (screen-reader label, placeholder), translated. */
export function translatedProps(
  props: object,
  t: (text: string) => string,
): Record<string, string> {
  const translated: Record<string, string> = {};
  for (const name of LABEL_PROPS) {
    const value = (props as Record<string, unknown>)[name];
    if (typeof value === 'string') translated[name] = t(value);
  }
  return translated;
}
