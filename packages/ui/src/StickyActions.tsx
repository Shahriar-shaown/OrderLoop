import type { ReactNode } from 'react';
import { Platform, View, type ViewStyle } from 'react-native';
import { Stack } from './Stack';
import { useTheme } from './theme';
import { layout, space } from './tokens';
import { useBreakpoint } from './useBreakpoint';

/**
 * The action row at the end of a form (Save, Cancel). On a phone on the web it sticks above the bottom bar so the main
 * action stays within reach while the form scrolls; elsewhere it is a plain row.
 */
export function StickyActions({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  const { isMobile } = useBreakpoint();
  if (!isMobile)
    return (
      <Stack direction="row" gap={2} wrap align="center">
        {children}
      </Stack>
    );
  const sticky =
    Platform.OS === 'web'
      ? ({ position: 'sticky', bottom: layout.bottomBar, zIndex: 5 } as unknown as ViewStyle)
      : null;
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: space[2],
          padding: space[3],
          backgroundColor: colors.surface,
          borderTopWidth: 1,
          borderTopColor: colors.border,
        },
        sticky,
      ]}
    >
      {children}
    </View>
  );
}
