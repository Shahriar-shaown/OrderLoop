import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Tests run from the package folder.
const SRC = join(process.cwd(), 'src') + '/';

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });

/** Components that translate their own label props, so a caller may pass them plain English. */
const TRANSLATING = new Set(['Button', 'Form', 'TextField']);

// `aria-label=…` / `accessibilityLabel=…` on an element, or an `'aria-label': …` object key; the rest of the line is its value.
const LABEL = /(?:\b(?:aria-label|accessibilityLabel)=|'aria-label':\s*)([^\n]*)/g;

/** Every raw label (not a `t(...)` call, not on a component that translates it) in one file's text. */
function rawLabels(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(LABEL)) {
    const value = match[1]!;
    if (/\bt\(/.test(value)) continue;
    const tag = /<([A-Za-z]+)(?![\s\S]*<[A-Za-z]+[\s>])/.exec(text.slice(0, match.index))?.[1];
    if (tag && TRANSLATING.has(tag)) continue;
    found.push(match[0].trim());
  }
  return found;
}

describe('accessible names in packages/ui', () => {
  it('are translated: no aria-label / accessibilityLabel is given as raw text', () => {
    const offenders = sourceFiles(SRC).flatMap((file) =>
      rawLabels(readFileSync(file, 'utf8')).map((label) => `${file.slice(SRC.length)}: ${label}`),
    );
    expect(offenders).toEqual([]);
  });

  it('the check itself flags raw labels and accepts translated ones', () => {
    expect(rawLabels('<View aria-label="Close" />')).toHaveLength(1);
    expect(rawLabels('<View aria-label={label} />')).toHaveLength(1);
    expect(rawLabels("<Svg {...{ 'aria-label': label }} />")).toHaveLength(1);
    expect(rawLabels('<View aria-label={t(label)} />')).toEqual([]);
    expect(rawLabels('<Button accessibilityLabel="Close" />')).toEqual([]);
  });
});
