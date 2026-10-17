import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ThemeProvider } from './theme';
import { THEME_STORAGE_KEY, themeInitScript } from './themeContext';
import { ThemeToggle } from './ThemeToggle';

const mount = () =>
  render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.scheme;
});

describe('ThemeToggle (web)', () => {
  it('starts on Auto, following the device', () => {
    mount();
    expect(screen.getByRole('radio', { name: 'Auto' })).toBeChecked();
    expect(document.documentElement.dataset.scheme).toBeUndefined();
  });

  it('forces dark or light on the page root and remembers it', async () => {
    mount();
    await userEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked();
    expect(document.documentElement.dataset.scheme).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    await userEvent.click(screen.getByRole('radio', { name: 'Light' }));
    expect(document.documentElement.dataset.scheme).toBe('light');
  });

  it('Auto clears the forced scheme and the saved choice', async () => {
    mount();
    await userEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Auto' }));
    expect(document.documentElement.dataset.scheme).toBeUndefined();
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('restores a saved choice on the next visit without overwriting it', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    mount();
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked());
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('ignores a corrupted saved value', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'purple');
    mount();
    expect(screen.getByRole('radio', { name: 'Auto' })).toBeChecked();
  });
});

describe('themeInitScript', () => {
  it('applies a saved scheme before first paint, and nothing for other values', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    new Function(themeInitScript)();
    expect(document.documentElement.dataset.scheme).toBe('dark');
    delete document.documentElement.dataset.scheme;
    localStorage.setItem(THEME_STORAGE_KEY, 'nonsense');
    new Function(themeInitScript)();
    expect(document.documentElement.dataset.scheme).toBeUndefined();
  });
});
