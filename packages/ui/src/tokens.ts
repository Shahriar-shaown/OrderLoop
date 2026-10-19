/**
 * The design tokens: every colour, space, radius and type size used by every component, on web and mobile alike. Components
 * never hard-code a value; they read these through the theme. To restyle the product, change this file.
 */
export type Tone = 'info' | 'success' | 'warning' | 'error' | 'neutral' | 'brand';
export const TONES = ['info', 'success', 'warning', 'error', 'neutral', 'brand'] as const;

export interface Palette {
  /** The page behind everything. Cards and fields sit on `surface`. */
  background: string;
  foreground: string;
  muted: string;
  border: string;
  /** A stronger line, for inputs. */
  borderStrong: string;
  /** Cards, fields, dialogs, tables. */
  surface: string;
  /** Hover fills, table headers, tracks. */
  subtle: string;
  primary: string;
  primaryHover: string;
  /** Selected-row and active-nav fill. */
  primarySoft: string;
  primaryTint: string;
  onPrimary: string;
  /** Teal: fills, charts and icons. Text on teal tint uses `accentText`. */
  accent: string;
  accentSoft: string;
  accentText: string;
  danger: string;
  dangerHover: string;
  onDanger: string;
  focus: string;
  overlay: string;
  tones: Record<Tone, { background: string; border: string; text: string; dot: string }>;
}

/** Colours for data: series in the order they are used. */
export const chartColors = [
  '#4f46e5',
  '#14b8a6',
  '#f59e0b',
  '#f43f5e',
  '#38bdf8',
  '#94a3b8',
] as const;

const light: Palette = {
  background: '#f8fafc',
  foreground: '#0f172a',
  muted: '#556479',
  border: '#e2e8f0',
  borderStrong: '#cbd5e1',
  surface: '#ffffff',
  subtle: '#f1f5f9',
  primary: '#4f46e5',
  primaryHover: '#3730a3',
  primarySoft: '#eef2ff',
  primaryTint: '#e0e7ff',
  onPrimary: '#ffffff',
  accent: '#14b8a6',
  accentSoft: '#f0fdfa',
  accentText: '#0f766e',
  danger: '#dc2626',
  dangerHover: '#b91c1c',
  onDanger: '#ffffff',
  focus: 'rgba(79,70,229,0.35)',
  overlay: 'rgba(15,23,42,0.5)',
  tones: {
    info: { background: '#e0f2fe', border: '#bae6fd', text: '#0369a1', dot: '#0ea5e9' },
    success: { background: '#dcfce7', border: '#bbf7d0', text: '#15803d', dot: '#16a34a' },
    warning: { background: '#fef3c7', border: '#fde68a', text: '#b45309', dot: '#f59e0b' },
    error: { background: '#fee2e2', border: '#fecaca', text: '#b91c1c', dot: '#dc2626' },
    neutral: { background: '#f1f5f9', border: '#e2e8f0', text: '#334155', dot: '#94a3b8' },
    brand: { background: '#eef2ff', border: '#e0e7ff', text: '#4338ca', dot: '#4f46e5' },
  },
};

const dark: Palette = {
  background: '#0b1120',
  foreground: '#f1f5f9',
  muted: '#94a3b8',
  border: '#1e293b',
  borderStrong: '#334155',
  surface: '#111827',
  subtle: '#1e293b',
  primary: '#818cf8',
  primaryHover: '#a5b4fc',
  primarySoft: '#1e1b4b',
  primaryTint: '#312e81',
  onPrimary: '#0b0b24',
  accent: '#2dd4bf',
  accentSoft: '#042f2e',
  accentText: '#5eead4',
  danger: '#f87171',
  dangerHover: '#fca5a5',
  onDanger: '#1c0505',
  focus: 'rgba(165,180,252,0.5)',
  overlay: 'rgba(0,0,0,0.7)',
  tones: {
    info: { background: '#082f49', border: '#0369a1', text: '#bae6fd', dot: '#38bdf8' },
    success: { background: '#052e16', border: '#15803d', text: '#bbf7d0', dot: '#4ade80' },
    warning: { background: '#451a03', border: '#b45309', text: '#fde68a', dot: '#fbbf24' },
    error: { background: '#450a0a', border: '#b91c1c', text: '#fecaca', dot: '#f87171' },
    neutral: { background: '#1e293b', border: '#334155', text: '#e2e8f0', dot: '#94a3b8' },
    brand: { background: '#1e1b4b', border: '#3730a3', text: '#c7d2fe', dot: '#818cf8' },
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

export const radius = { sm: 6, md: 8, lg: 12, xl: 16, full: 999 } as const;

/** Breakpoints from the design: mobile < 768, tablet 768–1279, desktop ≥ 1280. */
export const breakpoints = { tablet: 768, desktop: 1280 } as const;

/** The three elevations of the design (web `box-shadow`; native approximates with elevation). */
export const shadow = {
  sm: '0 1px 2px rgba(15,23,42,0.06)',
  md: '0 4px 12px rgba(15,23,42,0.08)',
  lg: '0 12px 32px rgba(15,23,42,0.16)',
} as const;

/** Layout measures from the design. */
export const layout = {
  sidebar: 248,
  rail: 72,
  header: 64,
  headerMobile: 56,
  bottomBar: 64,
  contentMax: 1128,
  drawer: 480,
  drawerTablet: 420,
} as const;

export const fontSize = { xs: 12, sm: 14, md: 16, lg: 18, xl: 22, '2xl': 28 } as const;
export const lineHeight = { xs: 16, sm: 20, md: 24, lg: 26, xl: 30, '2xl': 36 } as const;

/** The type scale of the design (Inter). One place; components pick a style, never a free size. */
export const type = {
  hero: { fontSize: 32, lineHeight: 40, fontWeight: '700' },
  h1: { fontSize: 24, lineHeight: 32, fontWeight: '600' },
  h2: { fontSize: 18, lineHeight: 28, fontWeight: '600' },
  h3: { fontSize: 15, lineHeight: 22, fontWeight: '600' },
  metric: { fontSize: 28, lineHeight: 36, fontWeight: '600' },
  body: { fontSize: 14, lineHeight: 20, fontWeight: '400' },
  bodyMedium: { fontSize: 14, lineHeight: 20, fontWeight: '500' },
  small: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  label: { fontSize: 12, lineHeight: 16, fontWeight: '500' },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '400' },
} as const;

export const fontFamily =
  "'Inter Variable', Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";

/** Minimum comfortable touch target (WCAG 2.5.8 asks for 24, platform guidelines for 44). */
export const touchTarget = 44;
