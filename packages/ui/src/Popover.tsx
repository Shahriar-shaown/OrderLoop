import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Modal, Pressable, View, useWindowDimensions, type ViewStyle } from 'react-native';
import { useTheme } from './theme';
import { radius, shadow } from './tokens';

export interface PopoverTriggerProps {
  open: boolean;
  /** Spread onto the pressable that opens it. */
  onPress: () => void;
  'aria-haspopup': 'menu' | 'listbox' | 'dialog';
  'aria-expanded': boolean;
}

/**
 * A floating panel anchored under a trigger (a menu, a filter, a switcher). It sits above the page, closes on a click
 * outside or Escape, and flips to the right edge when it would run off the screen. `children` may be a function that
 * receives `close`.
 */
export function Popover({
  trigger,
  children,
  align = 'start',
  width,
  haspopup = 'menu',
}: {
  trigger: (props: PopoverTriggerProps) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'start' | 'end';
  width?: number;
  haspopup?: 'menu' | 'listbox' | 'dialog';
}) {
  const { colors } = useTheme();
  const window = useWindowDimensions();
  const ref = useRef<View>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [panelHeight, setPanelHeight] = useState<number | null>(null);
  const close = useCallback(() => {
    setAnchor(null);
    setPanelHeight(null);
  }, []);
  const open = useCallback(() => {
    ref.current?.measureInWindow((x, y, w, h) => setAnchor({ x, y, w, h }));
  }, []);
  const panelWidth = width ?? 240;
  let left = 0;
  let top = 0;
  if (anchor) {
    left = align === 'end' ? anchor.x + anchor.w - panelWidth : anchor.x;
    left = Math.max(8, Math.min(left, window.width - panelWidth - 8));
    top = anchor.y + anchor.h + 6;
    // Not enough room below: open above the trigger instead, or as high as the screen allows.
    if (panelHeight !== null && top + panelHeight > window.height - 8) {
      const above = anchor.y - panelHeight - 6;
      top = above >= 8 ? above : Math.max(8, window.height - panelHeight - 8);
    }
  }
  const panel: ViewStyle = {
    position: 'absolute',
    left,
    top,
    width: panelWidth,
    maxHeight: window.height - 16,
    // Hidden for the one frame in which its height is measured, so it never flashes in the wrong place.
    opacity: panelHeight === null ? 0 : 1,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 6,
    ...({ boxShadow: shadow.lg } as object),
  };
  return (
    <>
      <View ref={ref} collapsable={false} style={{ alignSelf: 'flex-start' }}>
        {trigger({
          open: anchor !== null,
          onPress: open,
          'aria-haspopup': haspopup,
          'aria-expanded': anchor !== null,
        })}
      </View>
      <Modal visible={anchor !== null} transparent animationType="none" onRequestClose={close}>
        <Pressable
          accessible={false}
          aria-hidden
          onPress={close}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        />
        <View
          role={haspopup === 'dialog' ? 'dialog' : haspopup === 'menu' ? 'menu' : 'list'}
          style={panel}
          onLayout={(e) => setPanelHeight(Math.round(e.nativeEvent.layout.height))}
        >
          {typeof children === 'function' ? children(close) : children}
        </View>
      </Modal>
    </>
  );
}
