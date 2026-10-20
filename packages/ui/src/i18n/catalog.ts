import type { Locale } from './locales';

/**
 * The translation catalogues. The English text in the source is the key (as in gettext), so screens stay readable and a
 * string without a translation still renders in English.
 *
 * An entry is either plain text, or a pattern: a key with `{name}` placeholders ("Showing {a}–{b} of {c} orders") matches
 * text built at run time, and the matched pieces are carried into the translation.
 */
export type Catalog = Record<string, string>;

export interface Pattern {
  re: RegExp;
  target: string;
  /** The placeholder names, in the order their pieces are captured by `re`. */
  names: string[];
  /** How much fixed text the pattern has: the less, the more likely it is to match by accident. */
  literalLength: number;
}

export interface CompiledCatalog {
  exact: Map<string, string>;
  patterns: Pattern[];
}

const catalogs = new Map<Locale, CompiledCatalog>();
const missing = new Set<string>();
const MAX_MISSING_KEPT = 2000;

const escapeForRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function compilePattern(source: string, target: string): Pattern {
  const names: string[] = [];
  const body = escapeForRegExp(source).replace(/\\\{(\w+)\\\}/g, (_, name: string) => {
    names.push(name);
    return '(.+?)';
  });
  return {
    re: new RegExp(`^${body}$`),
    target,
    names,
    literalLength: source.replace(/\{\w+\}/g, '').replace(/[^A-Za-z]/g, '').length,
  };
}

/** Add translations for a locale. Each package registers its own; for the same key the later entry wins. */
export function registerCatalog(locale: Locale, entries: Catalog): void {
  const catalog: CompiledCatalog = catalogs.get(locale) ?? { exact: new Map(), patterns: [] };
  for (const [source, target] of Object.entries(entries)) {
    if (/\{\w+\}/.test(source)) catalog.patterns.push(compilePattern(source, target));
    else catalog.exact.set(source, target);
  }
  catalogs.set(locale, catalog);
}

export const catalogFor = (locale: Locale): CompiledCatalog | undefined => catalogs.get(locale);

/** Remember English text that was shown in another language because it had no translation. */
export function recordMissing(text: string): void {
  if (missing.size < MAX_MISSING_KEPT) missing.add(text);
}

/** The English strings shown in Bangla without a translation (for translators and for QA). */
export const missingTranslations = (): string[] => [...missing].sort();
