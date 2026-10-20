import { useState } from 'react';
import { Platform, TextInput, View, type TextInputProps } from 'react-native';
import { Icon } from '../feedback/Icon';
import { Text } from '../Text';
import { useTheme } from '../theme/theme';
import { fontFamily, radius, space, touchTarget } from '../theme/tokens';
import { useBreakpoint } from '../layout/useBreakpoint';
import { translatedProps, useT } from '../i18n';

/** A search box with a leading magnifier and an optional shortcut hint (⌘K). The label is for screen readers. */
export function SearchField({
  label,
  hint,
  value,
  onChangeText,
  ...rest
}: Omit<TextInputProps, 'style' | 'aria-label'> & { label: string; hint?: string }) {
  const { colors } = useTheme();
  const t = useT();
  const { isTouch } = useBreakpoint();
  const [focused, setFocused] = useState(false);
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[2],
        minHeight: isTouch ? touchTarget : 40,
        paddingHorizontal: space[3],
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: focused ? colors.primary : colors.borderStrong,
        backgroundColor: colors.surface,
        ...(focused
          ? ({ outlineWidth: 3, outlineStyle: 'solid', outlineColor: colors.focus } as object)
          : {}),
      }}
    >
      <Icon name="search" size={16} color={colors.muted} />
      <TextInput
        accessibilityLabel={t(label)}
        aria-label={t(label)}
        value={value}
        onChangeText={onChangeText}
        placeholderTextColor={colors.muted}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        role="searchbox"
        style={[
          { flex: 1, minWidth: 0, fontSize: 14, color: colors.foreground, paddingVertical: 8 },
          Platform.OS === 'web' ? ({ outlineStyle: 'none', fontFamily } as object) : null,
        ]}
        {...rest}
        {...translatedProps(rest, t)}
      />
      {hint && !focused && (
        <View
          style={{
            borderRadius: radius.sm,
            borderWidth: 1,
            borderColor: colors.border,
            paddingHorizontal: 6,
            paddingVertical: 1,
            backgroundColor: colors.subtle,
          }}
        >
          <Text variant="caption" tone="muted">
            {hint}
          </Text>
        </View>
      )}
    </View>
  );
}
