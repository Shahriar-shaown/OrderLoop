import { useMemo, useState, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import {
  ThemeContext,
  ThemePreferenceContext,
  type Theme,
  type ThemePreference,
} from './themeContext';
import { palettes } from './tokens';

export { useTheme, useThemePreference, type Theme, type ThemePreference } from './themeContext';

/**
 * Native implementation: the palette follows the device's light/dark setting unless the person picked one (kept for this
 * session). (theme.web.tsx uses CSS variables and remembers the choice in the browser.)
 */
export function ThemeProvider({
  children,
  defaultPreference = 'system',
}: {
  children: ReactNode;
  defaultPreference?: ThemePreference;
}) {
  const device = useColorScheme();
  const [preference, setPreference] = useState<ThemePreference>(defaultPreference);
  const resolved = preference === 'system' ? (device === 'dark' ? 'dark' : 'light') : preference;
  const theme = useMemo<Theme>(
    () => ({ scheme: resolved, colors: palettes[resolved] }),
    [resolved],
  );
  const choice = useMemo(() => ({ preference, setPreference }), [preference]);
  return (
    <ThemePreferenceContext.Provider value={choice}>
      <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>
    </ThemePreferenceContext.Provider>
  );
}
