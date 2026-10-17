import { describe, expect, it } from 'vitest';
import { cssPalette, themeStyleSheet } from './cssVars';
import { palettes } from './tokens';

describe('web theme', () => {
  it('hands components var() references, never fixed colours, so server and client markup match', () => {
    const palette = cssPalette();
    expect(palette.background).toBe('var(--ol-background)');
    expect(palette.primaryHover).toBe('var(--ol-primary-hover)');
    expect(palette.tones.error.text).toBe('var(--ol-tone-error-text)');
  });

  it('defines every variable for light, and again for dark under the media query and data-scheme', () => {
    const sheet = themeStyleSheet();
    expect(sheet).toContain(`--ol-background:${palettes.light.background}`);
    expect(sheet).toMatch(
      /@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-scheme="light"\]\)\{[^}]*--ol-background:#09090b/,
    );
    expect(sheet).toContain(':root[data-scheme="dark"]');
  });

  it('keeps light and dark palettes in the same shape (a missing key would crash one scheme only)', () => {
    expect(Object.keys(palettes.dark).sort()).toEqual(Object.keys(palettes.light).sort());
    expect(Object.keys(palettes.dark.tones)).toEqual(Object.keys(palettes.light.tones));
  });
});
