import { View } from 'react-native';
import { useTheme } from '../theme/theme';

export function Divider() {
  const { colors } = useTheme();
  return (
    <View
      role="separator"
      style={{ height: 1, alignSelf: 'stretch', backgroundColor: colors.border }}
    />
  );
}
