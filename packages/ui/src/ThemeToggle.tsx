import { Pressable, View } from 'react-native';
import { Text } from './Text';
import { useTheme, useThemePreference, type ThemePreference } from './theme';
import { radius, space } from './tokens';

const OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** Switches between following the device (Auto), light and dark. The choice is remembered. */
export function ThemeToggle() {
  const { colors } = useTheme();
  const { preference, setPreference } = useThemePreference();
  return (
    <View
      role="radiogroup"
      aria-label="Colour theme"
      style={{
        flexDirection: 'row',
        alignSelf: 'flex-start',
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.md,
        overflow: 'hidden',
      }}
    >
      {OPTIONS.map((o) => {
        const selected = preference === o.value;
        return (
          <Pressable
            key={o.value}
            role="radio"
            aria-checked={selected}
            onPress={() => setPreference(o.value)}
            style={{
              paddingHorizontal: space[3],
              paddingVertical: space[1],
              minHeight: 44,
              justifyContent: 'center',
              backgroundColor: selected ? colors.primary : 'transparent',
            }}
          >
            <Text variant="caption" weight="medium" tone={selected ? 'onPrimary' : 'default'}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
