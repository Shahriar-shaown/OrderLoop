/**
 * The design tokens: every colour, space, radius and type size used by every component, on web and mobile alike. Components
 * never hard-code a value; they read these through the theme. To restyle the product, change this file.
 */
export interface Palette {
  background: string;
  foreground: string;
  muted: string;
  border: string;
  surface: string;
  primary: string;
  primaryHover: string;
  onPrimary: string;
  danger: string;
  dangerHover: string;
  onDanger: string;
  focus: string;
  overlay: string;
  tones: Record<
    'info' | 'success' | 'warning' | 'error' | 'neutral',
    { background: string; border: string; text: string }
  >;
}

const light: Palette = {
  background: '#ffffff',
  foreground: '#18181b',
  muted: '#52525b',
  border: '#d4d4d8',
  surface: '#fafafa',
  primary: '#4f46e5',
  primaryHover: '#4338ca',
  onPrimary: '#ffffff',
  danger: '#b91c1c',
  dangerHover: '#991b1b',
  onDanger: '#ffffff',
  focus: '#4f46e5',
  overlay: 'rgba(0,0,0,0.5)',
  tones: {
    info: { background: '#e0f2fe', border: '#7dd3fc', text: '#0c4a6e' },
    success: { background: '#d1fae5', border: '#6ee7b7', text: '#064e3b' },
    warning: { background: '#fef3c7', border: '#fcd34d', text: '#78350f' },
    error: { background: '#fee2e2', border: '#fca5a5', text: '#7f1d1d' },
    neutral: { background: '#f4f4f5', border: '#d4d4d8', text: '#27272a' },
  },
};

const dark: Palette = {
  background: '#09090b',
  foreground: '#f4f4f5',
  muted: '#a1a1aa',
  border: '#3f3f46',
  surface: '#18181b',
  primary: '#818cf8',
  primaryHover: '#a5b4fc',
  onPrimary: '#0b0b24',
  danger: '#f87171',
  dangerHover: '#fca5a5',
  onDanger: '#1c0505',
  focus: '#a5b4fc',
  overlay: 'rgba(0,0,0,0.7)',
  tones: {
    info: { background: '#0c4a6e', border: '#0369a1', text: '#e0f2fe' },
    success: { background: '#064e3b', border: '#047857', text: '#d1fae5' },
    warning: { background: '#78350f', border: '#b45309', text: '#fef3c7' },
    error: { background: '#7f1d1d', border: '#b91c1c', text: '#fee2e2' },
    neutral: { background: '#27272a', border: '#52525b', text: '#f4f4f5' },
  },
};

export const palettes = { light, dark } as const;
export type Scheme = keyof typeof palettes;

/** Spacing scale in logical pixels (4-pt grid). */
export const space = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
} as const;
export type Space = keyof typeof space;

export const radius = { sm: 4, md: 8, lg: 12, full: 999 } as const;

export const fontSize = { xs: 12, sm: 14, md: 16, lg: 18, xl: 22, '2xl': 28 } as const;
export const lineHeight = { xs: 16, sm: 20, md: 24, lg: 26, xl: 30, '2xl': 36 } as const;

/** Minimum comfortable touch target (WCAG 2.5.8 asks for 24, platform guidelines for 44). */
export const touchTarget = 44;
