import { Pressable, View } from 'react-native';
import { Text } from './Text';
import { useTheme } from './theme';
import { radius, space, touchTarget } from './tokens';

/**
 * A tick box. Always give it a `label`: on a table row use `hideLabel` and name the row ("Select order 1001"), so a screen
 * reader says what is being selected.
 */
export function Checkbox({
  checked,
  onChange,
  label,
  hideLabel = false,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hideLabel?: boolean;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={() => onChange(!checked)}
      style={(state) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: space[2],
          minHeight: touchTarget,
          minWidth: touchTarget,
          opacity: disabled ? 0.5 : 1,
        },
        (state as { focused?: boolean }).focused
          ? { outlineWidth: 2, outlineStyle: 'solid', outlineColor: colors.focus, outlineOffset: 2 }
          : null,
      ]}
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: radius.sm,
          borderWidth: 2,
          borderColor: checked ? colors.primary : colors.muted,
          backgroundColor: checked ? colors.primary : colors.background,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {checked ? (
          <Text style={{ color: colors.onPrimary, lineHeight: 18, fontWeight: '700' }}>✓</Text>
        ) : null}
      </View>
      {hideLabel ? null : <Text>{label}</Text>}
    </Pressable>
  );
}
