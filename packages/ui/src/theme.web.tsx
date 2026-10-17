import { createElement, useEffect, useMemo, type ReactNode } from 'react';
import { cssPalette, themeStyleSheet } from './cssVars';
import { ThemeContext, useTheme, type Theme } from './themeContext';
import type { Scheme } from './tokens';

export type { Theme };
export { useTheme };

const COLORS = cssPalette();
const SHEET = themeStyleSheet();

/**
 * Web implementation: colours are CSS variables, resolved by the browser (see cssVars.ts), so server and client render
 * identical markup. `scheme` forces light or dark by setting data-scheme on the page root.
 */
export function ThemeProvider({ children, scheme }: { children: ReactNode; scheme?: Scheme }) {
  // `scheme` here is only the explicit override; the live scheme is whatever the browser resolves, so components must
  // not branch on it in JavaScript. They use `colors` only.
  const theme = useMemo<Theme>(() => ({ scheme: scheme ?? 'light', colors: COLORS }), [scheme]);
  // An explicit scheme (for example a future "always dark" setting) is applied to the page root; without one the
  // browser follows the visitor's system preference through the media query in the stylesheet.
  useEffect(() => {
    if (!scheme) return;
    document.documentElement.dataset.scheme = scheme;
    return () => {
      delete document.documentElement.dataset.scheme;
    };
  }, [scheme]);
  return (
    <ThemeContext.Provider value={theme}>
      {createElement('style', { id: 'ol-theme', dangerouslySetInnerHTML: { __html: SHEET } })}
      {children}
    </ThemeContext.Provider>
  );
}
