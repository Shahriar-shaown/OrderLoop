import { createContext, useContext } from 'react';
import type { Palette, Scheme } from './tokens';

export interface Theme {
  scheme: Scheme;
  colors: Palette;
}

/** Shared by both ThemeProvider implementations (native and web). Platform files must import this, never each other. */
export const ThemeContext = createContext<Theme | null>(null);

export function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error('UI components must be rendered inside <ThemeProvider>');
  return theme;
}
