import { createElement, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { cssPalette, themeStyleSheet } from './cssVars';
import {
  THEME_STORAGE_KEY,
  ThemeContext,
  ThemePreferenceContext,
  useTheme,
  useThemePreference,
  type Theme,
  type ThemePreference,
} from './themeContext';

export type { Theme, ThemePreference };
export { useTheme, useThemePreference };

const COLORS = cssPalette();
const SHEET = themeStyleSheet();

function readSaved(): ThemePreference | null {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return saved === 'light' || saved === 'dark' ? saved : null;
  } catch {
    return null; // storage blocked (private mode): the choice just lasts for this visit
  }
}

/**
 * Web implementation: colours are CSS variables, resolved by the browser (see cssVars.ts), so server and client render
 * identical markup. A chosen light/dark is applied by setting `data-scheme` on the page root and remembered in localStorage;
 * `system` removes it and the visitor's own setting decides, through a media query in the stylesheet.
 */
export function ThemeProvider({
  children,
  defaultPreference = 'system',
}: {
  children: ReactNode;
  defaultPreference?: ThemePreference;
}) {
  // The server cannot know the saved choice, so the first render is always the default; the saved one is read after mount
  // (themeInitScript has already applied it to the page, so nothing flashes).
  const [preference, setPreferenceState] = useState<ThemePreference>(defaultPreference);
  useEffect(() => {
    const saved = readSaved();
    if (saved) setPreferenceState(saved);
  }, []);

  // Applying and saving happen when the person chooses, never as a side effect of rendering, so a render can not undo a saved choice.
  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    const root = document.documentElement;
    if (next === 'system') delete root.dataset.scheme;
    else root.dataset.scheme = next;
    try {
      if (next === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // not remembered; the page still switches
    }
  }, []);

  // `scheme` is only a label here: the live scheme is whatever the browser resolves, so components use `colors` only.
  const theme = useMemo<Theme>(
    () => ({ scheme: preference === 'dark' ? 'dark' : 'light', colors: COLORS }),
    [preference],
  );
  const choice = useMemo(() => ({ preference, setPreference }), [preference, setPreference]);
  return (
    <ThemePreferenceContext.Provider value={choice}>
      <ThemeContext.Provider value={theme}>
        {createElement('style', { id: 'ol-theme', dangerouslySetInnerHTML: { __html: SHEET } })}
        {children}
      </ThemeContext.Provider>
    </ThemePreferenceContext.Provider>
  );
}
