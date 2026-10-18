import { useId, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { Button } from './Button';
import { Stack } from './Stack';
import { Text } from './Text';
import { useTheme } from './theme';
import { layout, radius, shadow, space } from './tokens';
import { useBreakpoint } from './useBreakpoint';

/**
 * A panel that slides over the page for detail and filters: a right-hand drawer (480 px on desktop, 420 px on tablet) and
 * a bottom sheet on a phone. Closes on a tap outside, the close button or Escape.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { colors } = useTheme();
  const { isMobile, isTablet } = useBreakpoint();
  const titleId = useId();
  const side = isMobile ? 'bottom' : 'right';
  return (
    <Modal
      visible={open}
      transparent
      animationType={isMobile ? 'slide' : 'fade'}
      onRequestClose={onClose}
    >
      <View
        style={{
          flex: 1,
          justifyContent: side === 'bottom' ? 'flex-end' : 'flex-start',
          alignItems: side === 'right' ? 'flex-end' : 'stretch',
        }}
      >
        <Pressable
          accessible={false}
          aria-hidden
          onPress={onClose}
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            backgroundColor: colors.overlay,
          }}
        />
        <View
          role="dialog"
          aria-modal
          aria-labelledby={titleId}
          style={[
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
              ...({ boxShadow: shadow.lg } as object),
            },
            side === 'right'
              ? {
                  width: isTablet ? layout.drawerTablet : layout.drawer,
                  maxWidth: '100%',
                  height: '100%',
                  borderLeftWidth: 1,
                }
              : {
                  width: '100%',
                  maxHeight: '88%',
                  borderTopLeftRadius: radius.xl,
                  borderTopRightRadius: radius.xl,
                  borderTopWidth: 1,
                },
          ]}
        >
          <Stack
            direction="row"
            justify="between"
            align="center"
            gap={3}
            style={{
              paddingHorizontal: space[5],
              paddingVertical: space[4],
              borderBottomWidth: 1,
              borderBottomColor: colors.border,
            }}
          >
            <Text
              nativeID={titleId}
              variant="title"
              role="heading"
              aria-level={2}
              style={{ flexShrink: 1 }}
            >
              {title}
            </Text>
            <Button
              variant="ghost"
              size="sm"
              icon="x"
              accessibilityLabel="Close"
              onPress={onClose}
            />
          </Stack>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: space[5], gap: space[4] }}
          >
            {children}
          </ScrollView>
          {footer && (
            <Stack
              direction="row"
              gap={2}
              justify="end"
              wrap
              style={{ padding: space[4], borderTopWidth: 1, borderTopColor: colors.border }}
            >
              {footer}
            </Stack>
          )}
        </View>
      </View>
    </Modal>
  );
}
