import { View } from 'react-native';
import { Icon } from './Icon';
import { Text } from './Text';
import { useTheme } from './theme';
import { radius, space, type Tone } from './tokens';

/** A change pill ("▲ 12.4%") with its direction as an icon and words, never colour alone. Used only where a real earlier figure exists. */
export function Delta({
  value,
  tone = 'success',
  direction,
}: {
  value: string;
  tone?: Tone;
  direction?: 'up' | 'down';
}) {
  const { colors } = useTheme();
  const c = colors.tones[tone];
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        alignSelf: 'flex-start',
        backgroundColor: c.background,
        borderRadius: radius.full,
        paddingHorizontal: space[2],
        paddingVertical: 1,
      }}
    >
      {direction && (
        <Icon name={direction === 'up' ? 'trend-up' : 'trend-down'} size={12} color={c.text} />
      )}
      <Text variant="fine" numeric style={{ color: c.text }}>
        {value}
      </Text>
    </View>
  );
}
