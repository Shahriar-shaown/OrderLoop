import { View, type DimensionValue } from 'react-native';
import { useTheme } from './theme';

/** A grey placeholder block shown while content loads. */
export function Skeleton({
  width = '100%',
  height = 16,
  radius = 6,
}: {
  width?: DimensionValue;
  height?: number;
  radius?: number;
}) {
  const { colors } = useTheme();
  return (
    <View
      aria-hidden
      style={{ width, height, borderRadius: radius, backgroundColor: colors.subtle }}
    />
  );
}
