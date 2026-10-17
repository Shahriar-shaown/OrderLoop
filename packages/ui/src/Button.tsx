import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  View,
  type GestureResponderEvent,
  type PressableProps,
} from 'react-native';
import { useFormSubmit } from './formContext';
import { useLinkPress, webLinkProps } from './Link';
import { Text } from './Text';
import { useTheme } from './theme';
import { radius, space, touchTarget } from './tokens';
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
      secondary: { backgroundColor: t.colors.background, borderColor: t.colors.border },
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
      sm: { paddingHorizontal: space[3], paddingVertical: space[1], minHeight: 32 },
      md: { paddingHorizontal: space[4], paddingVertical: space[2], minHeight: touchTarget },
      lg: { paddingHorizontal: space[6], paddingVertical: space[3], minHeight: 52 },
    },
    fullWidth: { true: { alignSelf: 'stretch' }, false: {} },
    disabled: { true: { opacity: 0.55 }, false: {} },
  },
  defaults: { variant: 'primary', size: 'md', fullWidth: 'false', disabled: 'false' },
}));

export interface ButtonProps extends Omit<PressableProps, 'children' | 'style' | 'onPress'> {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'link';
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
  /** Shows a spinner and blocks presses while a request is in flight. */
  loading?: boolean;
  /** Content before the label, for example an icon. */
  leading?: ReactNode;
  onPress?: (event: GestureResponderEvent) => void;
  /** `submit` submits the surrounding <Form>. */
  type?: 'button' | 'submit';
  /** Makes the button a link (on the web a real `<a>`), styled like a button. */
  href?: string;
}

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  loading = false,
  leading,
  disabled,
  onPress,
  type = 'button',
  href,
  ...rest
}: ButtonProps) {
  const { colors } = useTheme();
  const submit = useFormSubmit();
  const follow = useLinkPress(href ?? '', false, undefined);
  const inactive = Boolean(disabled || loading);
  const style = useButtonStyle({
    variant,
    size,
    fullWidth: String(fullWidth) as 'true',
    disabled: String(inactive) as 'true',
  });
  const labelTone =
    variant === 'primary'
      ? 'onPrimary'
      : variant === 'danger'
        ? 'onPrimary'
        : variant === 'link'
          ? 'primary'
          : 'default';
  const onDanger = variant === 'danger' ? { color: colors.onDanger } : undefined;

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
      style={(state) => [
        style,
        // Hover and keyboard focus feedback (the `hovered`/`focused` flags exist on the web; on native they are absent).
        (state as { hovered?: boolean }).hovered && !inactive && variant === 'primary'
          ? { backgroundColor: colors.primaryHover }
          : null,
        (state as { hovered?: boolean }).hovered && !inactive && variant === 'danger'
          ? { backgroundColor: colors.dangerHover }
          : null,
        (state as { hovered?: boolean }).hovered &&
        !inactive &&
        (variant === 'secondary' || variant === 'ghost')
          ? { backgroundColor: colors.surface }
          : null,
        state.pressed && !inactive ? { opacity: 0.85 } : null,
        (state as { focused?: boolean }).focused
          ? { outlineWidth: 2, outlineStyle: 'solid', outlineColor: colors.focus, outlineOffset: 2 }
          : null,
      ]}
      {...rest}
    >
      {loading ? (
        <ActivityIndicator
          size="small"
          color={variant === 'primary' || variant === 'danger' ? colors.onPrimary : colors.muted}
        />
      ) : leading ? (
        <View>{leading}</View>
      ) : null}
      <Text variant="label" tone={labelTone} {...(onDanger ? { style: onDanger } : {})}>
        {children}
      </Text>
    </Pressable>
  );
}
