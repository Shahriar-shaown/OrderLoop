import { View } from 'react-native';
import { Text } from './Text';
import { useTheme } from './theme';

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('') || '?';

/** A round badge with a person's (or a shop's) initials. */
export function Avatar({
  name,
  size = 32,
  tone = 'brand',
}: {
  name: string;
  size?: number;
  tone?: 'brand' | 'neutral';
}) {
  const { colors } = useTheme();
  const c = tone === 'brand' ? colors.tones.brand : colors.tones.neutral;
  return (
    <View
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: c.background,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text variant="fine" style={{ color: c.text, fontSize: Math.max(10, size * 0.36) }}>
        {initials(name)}
      </Text>
    </View>
  );
}
