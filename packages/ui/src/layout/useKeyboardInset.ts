import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

/**
 * How much of the bottom of the screen the on-screen keyboard covers, so a scrolling screen can leave room for it and
 * scroll the focused field into view. iOS does this itself (`automaticallyAdjustKeyboardInsets`). Android 15+ draws apps
 * edge to edge, where "resize" no longer shrinks the window, so there the screen must make the room itself.
 * Native; the browser handles the keyboard itself (useKeyboardInset.web.ts).
 */
export function useKeyboardInset(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const show = Keyboard.addListener('keyboardDidShow', (e) => setHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardDidHide', () => setHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return height;
}
