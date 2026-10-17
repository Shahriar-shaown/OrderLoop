import { Text as RNText, type TextProps as RNTextProps } from 'react-native';
import { fontSize, lineHeight } from './tokens';
import { useTheme } from './theme';
import { createTextVariants } from './variants';

/** The type scale. Use `variant` for meaning (a heading, a label), `tone` for emphasis; never raw font sizes. */
const useTextStyle = createTextVariants((t) => ({
  base: { color: t.colors.foreground },
  variants: {
    variant: {
      display: { fontSize: fontSize['2xl'], lineHeight: lineHeight['2xl'], fontWeight: '700' },
      title: { fontSize: fontSize.xl, lineHeight: lineHeight.xl, fontWeight: '600' },
      heading: { fontSize: fontSize.lg, lineHeight: lineHeight.lg, fontWeight: '600' },
      body: { fontSize: fontSize.sm, lineHeight: lineHeight.sm },
      bodyLarge: { fontSize: fontSize.md, lineHeight: lineHeight.md },
      label: { fontSize: fontSize.sm, lineHeight: lineHeight.sm, fontWeight: '500' },
      caption: { fontSize: fontSize.xs, lineHeight: lineHeight.xs },
      mono: {
        fontSize: fontSize.sm,
        lineHeight: lineHeight.sm,
        fontFamily: 'Menlo, Consolas, monospace',
      },
    },
    tone: {
      default: {},
      muted: { color: t.colors.muted },
      primary: { color: t.colors.primary },
      danger: { color: t.colors.danger },
      onPrimary: { color: t.colors.onPrimary },
    },
    align: {
      left: { textAlign: 'left' },
      center: { textAlign: 'center' },
      right: { textAlign: 'right' },
    },
    weight: {
      normal: { fontWeight: '400' },
      medium: { fontWeight: '500' },
      bold: { fontWeight: '700' },
    },
  },
  defaults: { variant: 'body', tone: 'default' },
}));

export interface TextProps extends RNTextProps {
  variant?: 'display' | 'title' | 'heading' | 'body' | 'bodyLarge' | 'label' | 'caption' | 'mono';
  tone?: 'default' | 'muted' | 'primary' | 'danger' | 'onPrimary';
  align?: 'left' | 'center' | 'right';
  weight?: 'normal' | 'medium' | 'bold';
}

export function Text({ variant, tone, align, weight, style, ...rest }: TextProps) {
  useTheme(); // fail loudly if rendered outside <ThemeProvider>
  const variantStyle = useTextStyle({ variant, tone, align, weight });
  // The two headline variants are announced as headings by screen readers (on the web: <h1>/<h2> semantics via role).
  const role = rest.role ?? (variant === 'display' || variant === 'title' ? 'heading' : undefined);
  return (
    <RNText
      role={role}
      {...(role === 'heading' ? { 'aria-level': variant === 'display' ? 1 : 2 } : {})}
      style={[variantStyle, style]}
      {...rest}
    />
  );
}
