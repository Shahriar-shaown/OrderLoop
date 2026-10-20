import { ActivityIndicator, View } from 'react-native';
import { Text } from '../Text';
import { useTheme } from '../theme/theme';
import { space } from '../theme/tokens';

/** A busy indicator. With `label`, it is a block that screen readers announce (`role="status"`). */
export function Spinner({
  label,
  size = 'small',
  inline = false,
}: {
  label?: string;
  size?: 'small' | 'large';
  inline?: boolean;
}) {
  const { colors } = useTheme();
  const indicator = (
    <ActivityIndicator
      size={size}
      color={inline ? 'currentColor' : colors.muted}
      accessibilityLabel={label ?? 'Loading'}
    />
  );
  if (inline || !label) return indicator;
  return (
    <View
      role="status"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[2],
        paddingVertical: space[6],
      }}
    >
      {indicator}
      <Text tone="muted">{label}…</Text>
    </View>
  );
}
