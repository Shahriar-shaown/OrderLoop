import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import { NavigationContext, type Navigation } from '../src/navigation';
import { ThemeProvider } from '../src/theme';
import { ToastProvider } from '../src/Toast';

export function makeNavigation(
  pathname = '/',
): Navigation & { push: ReturnType<typeof vi.fn>; replace: ReturnType<typeof vi.fn> } {
  return { pathname, push: vi.fn(), replace: vi.fn(), back: vi.fn() };
}

/** Render inside everything shared components expect: theme, navigation and toasts. */
export function renderUi(ui: ReactElement, navigation = makeNavigation()) {
  return {
    navigation,
    ...render(<NavigationContext.Provider value={navigation}>{ui}</NavigationContext.Provider>, {
      wrapper: ({ children }) => (
        <ThemeProvider>
          <ToastProvider>{children}</ToastProvider>
        </ThemeProvider>
      ),
    }),
  };
}
