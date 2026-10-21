import type { ReactNode } from 'react';
import { Platform, Text as RNText, type TextProps as RNTextProps } from 'react-native';
import { fontFamily, fontSize, lineHeight, type } from './theme/tokens';
import { localizeChildren, useLocale } from './i18n';
import { useTheme } from './theme/theme';
import { createTextVariants } from './theme/variants';

/** The type scale of the design. Use `variant` for meaning (a heading, a label), `tone` for emphasis; never raw font sizes. */
const useTextStyle = createTextVariants((t) => ({
  base: { color: t.colors.foreground, ...(Platform.OS === 'web' ? { fontFamily } : {}) },
  variants: {
    variant: {
      hero: type.hero,
      // The page title (the one h1 on a page): Heading/H1 24.
      display: type.h1,
      // Cards, dialogs and panels: Heading/H2 18.
      title: type.h2,
      // Table and card headers: Heading/H3 15.
      heading: type.h3,
      metric: type.metric,
      body: type.body,
      bodyLarge: { fontSize: fontSize.md, lineHeight: lineHeight.md },
      // Buttons and emphasised text: Body/Medium 14.
      label: type.bodyMedium,
      small: type.small,
      // Field labels, badges and tabs: Label/12.
      fine: type.label,
      caption: type.caption,
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
      success: { color: t.colors.tones.success.text },
      warning: { color: t.colors.tones.warning.text },
    },
    align: {
      left: { textAlign: 'left' },
      center: { textAlign: 'center' },
      right: { textAlign: 'right' },
    },
    weight: {
      normal: { fontWeight: '400' },
      medium: { fontWeight: '500' },
      semibold: { fontWeight: '600' },
      bold: { fontWeight: '700' },
    },
    // Money, counts and percentages line up in columns.
    numeric: { true: { fontVariant: ['tabular-nums'] }, false: {} },
  },
  defaults: { variant: 'body', tone: 'default', numeric: 'false' },
}));

export interface TextProps extends RNTextProps {
  variant?:
    | 'hero'
    | 'display'
    | 'title'
    | 'heading'
    | 'metric'
    | 'body'
    | 'bodyLarge'
    | 'label'
    | 'small'
    | 'fine'
    | 'caption'
    | 'mono';
  tone?: 'default' | 'muted' | 'primary' | 'danger' | 'onPrimary' | 'success' | 'warning';
  align?: 'left' | 'center' | 'right';
  weight?: 'normal' | 'medium' | 'semibold' | 'bold';
  /** Tabular figures, so numbers line up. Use for money, counts and percentages. */
  numeric?: boolean;
  /** Show the text exactly as given, in every language: for names and brands that must never be translated. */
  verbatim?: boolean;
}

// Bengali letters, vowel signs, conjunct joiners and digits (U+0980 to U+09F1): not the currency signs, so "৳" amounts are left alone.
const BENGALI = /[\u0980-\u09F1]/;
/**
 * Android measures Bengali conjuncts (like the "দ্দি" of "উদ্দিন") a little narrower than it paints them. A text box that is only
 * as wide as its measured text, such as a name beside a price, then wraps its last word onto a second line the box does not have
 * room for, and the word disappears. A few points of slack in the box prevents it.
 */
const HAIR_SPACE = '\u200A';
const withSlack = (node: ReactNode): ReactNode =>
  Platform.OS === 'android' && typeof node === 'string' && BENGALI.test(node)
    ? node + HAIR_SPACE.repeat(Math.max(3, Math.ceil(node.length / 8)))
    : node;

export function Text({
  variant,
  tone,
  align,
  weight,
  numeric,
  style,
  children,
  verbatim,
  ...rest
}: TextProps) {
  useTheme(); // fail loudly if rendered outside <ThemeProvider>
  const { locale } = useLocale();
  const variantStyle = useTextStyle({
    variant,
    tone,
    align,
    weight,
    numeric: String(Boolean(numeric)) as 'true',
  });
  // The two headline variants are announced as headings by screen readers (on the web: <h1>/<h2> semantics via role).
  const role = rest.role ?? (variant === 'display' || variant === 'title' ? 'heading' : undefined);
  return (
    <RNText
      role={role}
      {...(role === 'heading' ? { 'aria-level': variant === 'display' ? 1 : 2 } : {})}
      style={[variantStyle, style]}
      {...rest}
    >
      {withSlack(verbatim ? children : localizeChildren(locale, children))}
    </RNText>
  );
}
