import { useId } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from 'react-native';
import { DIALOG_WIDTHS, type DialogProps } from './dialogTypes';
import { Content } from '../layout/Content';
import { Stack } from '../layout/Stack';
import { useTheme } from '../theme/theme';
import { DialogHeader } from './DialogHeader';
import { radius, space } from '../theme/tokens';

export type { DialogProps } from './dialogTypes';

/** Native implementation: the system modal (with the hardware back button). Dialog.web.tsx uses the browser's `<dialog>`. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  icon,
  iconTone,
}: DialogProps) {
  const { colors } = useTheme();
  const titleId = useId();
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      {/* Lifts the dialog above the keyboard, so the focused field is never covered. */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: space[4] }}
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
          style={{
            width: '100%',
            maxWidth: DIALOG_WIDTHS[size],
            maxHeight: '90%',
            backgroundColor: colors.surface,
            borderRadius: radius.xl,
            borderWidth: 1,
            borderColor: colors.border,
          }}
        >
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: space[5], gap: space[4] }}
          >
            <DialogHeader titleId={titleId} title={title} icon={icon} iconTone={iconTone} />
            <Content>{children}</Content>
            {footer && (
              <Stack direction="row" gap={2} justify="end" wrap>
                {footer}
              </Stack>
            )}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
