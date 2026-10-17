import { useMemo, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { ThemeContext, type Theme } from './themeContext';
import { palettes, type Scheme } from './tokens';

export { useTheme, type Theme } from './themeContext';

/** Native implementation: picks the palette from the device's light/dark setting unless `scheme` forces one. (theme.web.tsx uses CSS variables.) */
export function ThemeProvider({ children, scheme }: { children: ReactNode; scheme?: Scheme }) {
  const device = useColorScheme();
  const resolved: Scheme = scheme ?? (device === 'dark' ? 'dark' : 'light');
  const theme = useMemo<Theme>(
    () => ({ scheme: resolved, colors: palettes[resolved] }),
    [resolved],
  );
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}
