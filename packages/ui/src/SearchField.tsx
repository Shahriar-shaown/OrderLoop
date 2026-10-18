import { useState } from 'react';
import { Platform, TextInput, View, type TextInputProps } from 'react-native';
import { Icon } from './Icon';
import { Text } from './Text';
import { useTheme } from './theme';
import { fontFamily, radius, space } from './tokens';
import { useBreakpoint } from './useBreakpoint';

/** A search box with a leading magnifier and an optional shortcut hint (⌘K). The label is for screen readers. */
export function SearchField({
  label,
  hint,
  value,
  onChangeText,
  placeholder,
  ...rest
}: Omit<TextInputProps, 'style' | 'aria-label'> & { label: string; hint?: string }) {
  const { colors } = useTheme();
  const { isMobile } = useBreakpoint();
  const [focused, setFocused] = useState(false);
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[2],
        minHeight: isMobile ? 44 : 40,
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
        accessibilityLabel={label}
        aria-label={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        role="searchbox"
        style={[
          { flex: 1, minWidth: 0, fontSize: 14, color: colors.foreground, paddingVertical: 8 },
          Platform.OS === 'web' ? ({ outlineStyle: 'none', fontFamily } as object) : null,
        ]}
        {...rest}
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
