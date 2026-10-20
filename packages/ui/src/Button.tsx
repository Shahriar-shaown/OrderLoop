import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  View,
  type GestureResponderEvent,
  type PressableProps,
} from 'react-native';
import { useFormSubmit } from './formContext';
import { translatedProps, useT } from './i18n';
import { Icon } from './Icon';
import type { IconName } from './icons';
import { useLinkPress, webLinkProps } from './Link';
import { Text } from './Text';
import { useTheme } from './theme';
import { radius, space, touchTarget } from './tokens';
import { useBreakpoint } from './useBreakpoint';
import { createVariants } from './variants';

const useButtonStyle = createVariants((t) => ({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  variants: {
    variant: {
      primary: { backgroundColor: t.colors.primary },
      secondary: { backgroundColor: t.colors.surface, borderColor: t.colors.borderStrong },
      // Quiet: indigo text, a tint on hover. For the third action on a row.
      tertiary: { backgroundColor: 'transparent' },
      danger: { backgroundColor: t.colors.danger },
      ghost: { backgroundColor: 'transparent' },
      link: {
        backgroundColor: 'transparent',
        paddingHorizontal: 0,
        paddingVertical: 0,
        minHeight: 0,
      },
    },
    size: {
      sm: { paddingHorizontal: space[3], paddingVertical: 0, minHeight: 32 },
      md: { paddingHorizontal: space[4], paddingVertical: 0, minHeight: 40 },
      lg: { paddingHorizontal: space[6], paddingVertical: 0, minHeight: 48 },
    },
    fullWidth: { true: { alignSelf: 'stretch' }, false: {} },
    disabled: { true: { opacity: 0.5 }, false: {} },
  },
  defaults: { variant: 'primary', size: 'md', fullWidth: 'false', disabled: 'false' },
}));

export interface ButtonProps extends Omit<PressableProps, 'children' | 'style' | 'onPress'> {
  children?: ReactNode;
  variant?: 'primary' | 'secondary' | 'tertiary' | 'danger' | 'ghost' | 'link';
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
  /** Shows a spinner and blocks presses while a request is in flight. */
  loading?: boolean;
  /** An icon before the label. */
  icon?: IconName;
  /** An icon after the label (a chevron on a menu button). */
  iconRight?: IconName;
  /** Content before the label, for something that is not in the icon set. */
  leading?: ReactNode;
  onPress?: (event: GestureResponderEvent) => void;
  /** `submit` submits the surrounding <Form>. */
  type?: 'button' | 'submit';
  /** Makes the button a link (on the web a real `<a>`), styled like a button. */
  href?: string;
}

/**
 * The button. Primary for the one main action, secondary for the others, tertiary for the quietest, danger for destructive
 * ones. On touch screens every size is at least 44 px tall. With no children it is an icon button and needs an
 * `accessibilityLabel`.
 */
export function Button({
  children,
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  loading = false,
  icon,
  iconRight,
  leading,
  disabled,
  onPress,
  type = 'button',
  href,
  ...rest
}: ButtonProps) {
  const { colors } = useTheme();
  const t = useT();
  const { isMobile } = useBreakpoint();
  const submit = useFormSubmit();
  const follow = useLinkPress(href ?? '', false, undefined);
  const inactive = Boolean(disabled || loading);
  const style = useButtonStyle({
    variant,
    size,
    fullWidth: String(fullWidth) as 'true',
    disabled: String(inactive) as 'true',
  });
  const filled = variant === 'primary' || variant === 'danger';
  const ink = filled
    ? variant === 'danger'
      ? colors.onDanger
      : colors.onPrimary
    : variant === 'tertiary' || variant === 'link'
      ? colors.primary
      : colors.foreground;
  const iconOnly = children === undefined || children === null || children === false;

  return (
    <Pressable
      role={href ? 'link' : 'button'}
      {...(href ? webLinkProps(href) : {})}
      aria-busy={loading || undefined}
      aria-disabled={inactive || undefined}
      disabled={inactive}
      onPress={(event) => {
        if (type === 'submit') submit?.();
        if (href) follow(event);
        onPress?.(event);
      }}
      style={(state) => {
        const hovered = (state as { hovered?: boolean }).hovered && !inactive;
        return [
          style,
          isMobile && variant !== 'link' ? { minHeight: touchTarget } : null,
          iconOnly ? { paddingHorizontal: 0, aspectRatio: 1 } : null,
          hovered && variant === 'primary' ? { backgroundColor: colors.primaryHover } : null,
          hovered && variant === 'danger' ? { backgroundColor: colors.dangerHover } : null,
          hovered && (variant === 'secondary' || variant === 'ghost')
            ? { backgroundColor: colors.subtle }
            : null,
          hovered && variant === 'tertiary' ? { backgroundColor: colors.primarySoft } : null,
          state.pressed && !inactive ? { opacity: 0.85 } : null,
          // A 3 px indigo ring at 35 %, outside the control, never removed (visible for keyboard focus).
          (state as { focused?: boolean }).focused
            ? {
                outlineWidth: 3,
                outlineStyle: 'solid',
                outlineColor: colors.focus,
                outlineOffset: 0,
              }
            : null,
        ];
      }}
      {...rest}
      {...translatedProps(rest, t)}
    >
      {loading ? (
        <ActivityIndicator size="small" color={filled ? ink : colors.muted} />
      ) : icon ? (
        <Icon name={icon} size={size === 'sm' ? 14 : 16} color={ink} />
      ) : leading ? (
        <View>{leading}</View>
      ) : null}
      {!iconOnly && (
        <Text variant={size === 'sm' ? 'fine' : 'label'} style={{ color: ink }}>
          {children}
        </Text>
      )}
      {iconRight && !loading && <Icon name={iconRight} size={14} color={ink} />}
    </Pressable>
  );
}
