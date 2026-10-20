import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ThemeProvider } from './theme';
import { createTextVariants as createVariants } from './variants';

const useStyle = createVariants(() => ({
  base: { padding: 1 },
  variants: {
    tone: { a: { color: 'red' }, b: { color: 'blue' } },
    size: { s: { fontSize: 10 }, l: { fontSize: 20 } },
  },
  defaults: { tone: 'a', size: 's' },
  compound: [{ when: { tone: 'b', size: 'l' }, style: { fontWeight: '700' } }],
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <ThemeProvider>{children}</ThemeProvider>
);
const flat = (style: unknown) => Object.assign({}, ...(style as object[]));

describe('createVariants', () => {
  it('applies the base and the default choices', () => {
    const { result } = renderHook(() => useStyle({}), { wrapper });
    expect(flat(result.current)).toEqual({ padding: 1, color: 'red', fontSize: 10 });
  });

  it('applies the chosen variants, later ones winning', () => {
    const { result } = renderHook(() => useStyle({ tone: 'b', size: 'l' }), { wrapper });
    expect(flat(result.current)).toEqual({
      padding: 1,
      color: 'blue',
      fontSize: 20,
      fontWeight: '700',
    });
  });

  it('applies a compound rule only when all its conditions hold', () => {
    const { result } = renderHook(() => useStyle({ tone: 'b', size: 's' }), { wrapper });
    expect(flat(result.current)).not.toHaveProperty('fontWeight');
  });

  it('refuses to render outside a ThemeProvider', () => {
    expect(() => renderHook(() => useStyle({}))).toThrow(/ThemeProvider/);
  });
});
