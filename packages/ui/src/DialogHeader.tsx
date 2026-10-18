import { View } from 'react-native';
import { Icon } from './Icon';
import type { IconName } from './icons';
import { Text } from './Text';
import { useTheme } from './theme';
import type { Tone } from './tokens';

/** The top of a dialog: an optional round icon, then the title. Shared by the web and native dialogs. */
export function DialogHeader({
  titleId,
  title,
  icon,
  iconTone = 'brand',
}: {
  titleId: string;
  title: string;
  icon?: IconName | undefined;
  iconTone?: Tone | undefined;
}) {
  const { colors } = useTheme();
  const c = colors.tones[iconTone];
  return (
    <View style={{ gap: 12 }}>
      {icon && (
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: c.background,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name={icon} size={20} color={c.text} />
        </View>
      )}
      <Text nativeID={titleId} variant="title" role="heading" aria-level={2}>
        {title}
      </Text>
    </View>
  );
}
