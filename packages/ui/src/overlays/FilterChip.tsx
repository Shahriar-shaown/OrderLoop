import { Pressable } from 'react-native';
import { Icon } from '../feedback/Icon';
import type { PopoverTriggerProps } from './Popover';
import { Text } from '../Text';
import { useTheme } from '../theme/theme';
import { radius, space } from '../theme/tokens';
import { useBreakpoint } from '../layout/useBreakpoint';

/** The chip that opens a filter panel ("Date: Any ▾"). Tinted while a filter is on. Pass the Popover's trigger props. */
export function FilterChip({
  text,
  active,
  popover,
}: {
  text: string;
  active: boolean;
  popover: PopoverTriggerProps;
}) {
  const { colors } = useTheme();
  const { isMobile } = useBreakpoint();
  return (
    <Pressable
      role="button"
      aria-haspopup={popover['aria-haspopup']}
      aria-expanded={popover['aria-expanded']}
      onPress={popover.onPress}
      style={(state) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: space[2],
          minHeight: isMobile ? 44 : 36,
          paddingHorizontal: space[3],
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: active ? colors.primaryTint : colors.borderStrong,
          backgroundColor: active ? colors.primarySoft : colors.surface,
        },
        (state as { hovered?: boolean }).hovered
          ? { backgroundColor: active ? colors.primaryTint : colors.subtle }
          : null,
        (state as { focused?: boolean }).focused
          ? ({ outlineWidth: 3, outlineStyle: 'solid', outlineColor: colors.focus } as object)
          : null,
      ]}
    >
      <Text variant="fine" style={{ color: active ? colors.tones.brand.text : colors.foreground }}>
        {text}
      </Text>
      <Icon name="chevron-down" size={14} color={colors.muted} />
    </Pressable>
  );
}
