import { palettes, type Palette } from './tokens';

/**
 * Web theming through CSS variables. The server cannot know whether a visitor prefers dark mode, so instead of choosing a
 * palette in JavaScript (which would render the wrong colours first and then flip, or mismatch on hydration), the web
 * theme hands components `var(--ol-...)` references and lets the browser pick the values. Server and client render
 * identical markup, and there is no flash.
 */
type Flat = Record<string, string>;

const TONES = ['info', 'success', 'warning', 'error', 'neutral'] as const;
const TONE_PARTS = ['background', 'border', 'text'] as const;
const SIMPLE = [
  'background',
  'foreground',
  'muted',
  'border',
  'surface',
  'primary',
  'primaryHover',
  'onPrimary',
  'danger',
  'dangerHover',
  'onDanger',
  'focus',
  'overlay',
] as const;

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function flatten(p: Palette): Flat {
  const out: Flat = {};
  for (const key of SIMPLE) out[`--ol-${kebab(key)}`] = p[key];
  for (const tone of TONES)
    for (const part of TONE_PARTS) out[`--ol-tone-${tone}-${part}`] = p.tones[tone][part];
  return out;
}

/** The same shape as a Palette, but every value is a `var()` reference. */
export function cssPalette(): Palette {
  const ref = (name: string) => `var(${name})`;
  const base = {} as Record<string, string>;
  for (const key of SIMPLE) base[key] = ref(`--ol-${kebab(key)}`);
  const tones = {} as Record<string, Record<string, string>>;
  for (const tone of TONES) {
    tones[tone] = {};
    for (const part of TONE_PARTS) tones[tone][part] = ref(`--ol-tone-${tone}-${part}`);
  }
  return { ...base, tones } as unknown as Palette;
}

const declarations = (vars: Flat) =>
  Object.entries(vars)
    .map(([k, v]) => `${k}:${v}`)
    .join(';');

/** The stylesheet that defines the variables: light by default, dark by media query, either forceable with data-scheme. */
export function themeStyleSheet(): string {
  const light = declarations(flatten(palettes.light));
  const dark = declarations(flatten(palettes.dark));
  return [
    `:root{${light};color-scheme:light}`,
    `@media (prefers-color-scheme:dark){:root:not([data-scheme="light"]){${dark};color-scheme:dark}}`,
    `:root[data-scheme="dark"]{${dark};color-scheme:dark}`,
    `body{background:var(--ol-background);color:var(--ol-foreground)}`,
    `.ol-skip{position:absolute;left:-9999px;top:8px;z-index:1000;padding:8px 12px;border-radius:8px;background:var(--ol-primary);color:var(--ol-on-primary);font:500 14px system-ui,sans-serif}`,
    `.ol-skip:focus{left:8px}`,
    `dialog.ol-dialog{width:calc(100% - 32px);padding:0;border:1px solid var(--ol-border);border-radius:12px;background:var(--ol-background);color:var(--ol-foreground)}`,
    `dialog.ol-dialog::backdrop{background:var(--ol-overlay)}`,
  ].join('\n');
}
