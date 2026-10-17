import { useId } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { DIALOG_WIDTHS, type DialogProps } from './dialogTypes';
import { Content } from './Content';
import { Stack } from './Stack';
import { Text } from './Text';
import { useTheme } from './theme';
import { radius, space } from './tokens';

export type { DialogProps } from './dialogTypes';

/** Native implementation: the system modal (with the hardware back button). Dialog.web.tsx uses the browser's `<dialog>`. */
export function Dialog({ open, onClose, title, children, footer, size = 'md' }: DialogProps) {
  const { colors } = useTheme();
  const titleId = useId();
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: space[4] }}>
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
          style={{
            width: '100%',
            maxWidth: DIALOG_WIDTHS[size],
            maxHeight: '90%',
            backgroundColor: colors.background,
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: colors.border,
          }}
        >
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: space[5], gap: space[4] }}
          >
            <Text nativeID={titleId} variant="heading" role="heading" aria-level={2}>
              {title}
            </Text>
            <Content>{children}</Content>
            {footer && (
              <Stack direction="row" gap={2} justify="end" wrap>
                {footer}
              </Stack>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
