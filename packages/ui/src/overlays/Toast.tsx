import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Platform, View, type ViewStyle } from 'react-native';
import { Button } from '../Button';
import { Icon } from '../feedback/Icon';
import type { Tone } from '../feedback/Badge';
import { Stack } from '../layout/Stack';
import { Text } from '../Text';
import { useTheme } from '../theme/theme';
import { radius, shadow, space } from '../theme/tokens';

interface ToastItem {
  id: number;
  tone: Tone;
  message: string;
}

export interface Toaster {
  success(message: string): void;
  error(message: string): void;
  info(message: string): void;
}

const ToastContext = createContext<Toaster | null>(null);

/** What the toast hosts draw, and which dialogs or sheets are open (innermost last). */
interface ToastState {
  items: ToastItem[];
  dismiss: (id: number) => void;
  layers: string[];
  setLayer: (id: string, open: boolean) => void;
}
const ToastStateContext = createContext<ToastState | null>(null);

export function useToast(): Toaster {
  const toaster = useContext(ToastContext);
  if (!toaster) throw new Error('useToast must be used inside <ToastProvider>');
  return toaster;
}

// Fixed to the window on the web (so it stays in view while the page scrolls), absolute on native.
const HOST = {
  position: Platform.OS === 'web' ? 'fixed' : 'absolute',
  left: 0,
  right: 0,
  bottom: space[4],
  // Above the bottom bar and the sheets, which have their own stacking.
  zIndex: 100,
  alignItems: 'center',
  gap: space[2],
  paddingHorizontal: space[4],
} as unknown as ViewStyle;

/** Short messages that confirm an action. Errors stay longer and are announced assertively. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const dismiss = useCallback(
    (id: number) => setItems((all) => all.filter((t) => t.id !== id)),
    [],
  );
  const push = useCallback((tone: Tone, message: string) => {
    const id = next.current++;
    setItems((all) => [...all.slice(-3), { id, tone, message }]);
  }, []);
  const [layers, setLayers] = useState<string[]>([]);
  const setLayer = useCallback(
    (id: string, open: boolean) =>
      setLayers((all) =>
        open ? [...all.filter((x) => x !== id), id] : all.filter((x) => x !== id),
      ),
    [],
  );
  const state = useMemo<ToastState>(
    () => ({ items, dismiss, layers, setLayer }),
    [items, dismiss, layers, setLayer],
  );
  const toaster = useMemo<Toaster>(
    () => ({
      success: (m) => push('success', m),
      error: (m) => push('error', m),
      info: (m) => push('info', m),
    }),
    [push],
  );
  return (
    <ToastContext.Provider value={toaster}>
      <ToastStateContext.Provider value={state}>
        {children}
        <ToastHost visible={layers.length === 0} />
      </ToastStateContext.Provider>
    </ToastContext.Provider>
  );
}

/**
 * Draws the toasts. A modal dialog or sheet covers everything outside its own layer (the browser's top layer, a native
 * Modal), so the page's host steps aside while one is open and the innermost one draws the toasts itself.
 */
export function ToastHost({ visible }: { visible: boolean }) {
  const state = useContext(ToastStateContext);
  if (!state || !visible || state.items.length === 0) return null;
  return (
    <View pointerEvents="box-none" style={HOST}>
      {state.items.map((t) => (
        <ToastView key={t.id} item={t} onDismiss={state.dismiss} />
      ))}
    </View>
  );
}

/** Called by a dialog or sheet: says it is open, and returns whether it is the innermost one (and so shows the toasts). */
export function useToastLayer(open: boolean): boolean {
  const id = useId();
  const state = useContext(ToastStateContext);
  const setLayer = state?.setLayer;
  useEffect(() => {
    if (!open) return;
    setLayer?.(id, true);
    return () => setLayer?.(id, false);
  }, [open, id, setLayer]);
  return open && state?.layers.at(-1) === id;
}

const TOAST_ICON = {
  success: 'check-circle',
  error: 'alert',
  info: 'info',
  warning: 'alert',
  neutral: 'info',
  brand: 'info',
} as const;

function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const { colors } = useTheme();
  const c = colors.tones[item.tone];
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(item.id), item.tone === 'error' ? 8000 : 5000);
    return () => clearTimeout(timer);
  }, [item, onDismiss]);
  return (
    <View
      role={item.tone === 'error' ? 'alert' : 'status'}
      style={{
        maxWidth: 440,
        width: '100%',
        backgroundColor: colors.surface,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.lg,
        padding: space[3],
        ...({ boxShadow: shadow.md } as object),
      }}
    >
      <Stack direction="row" gap={3} align="center" justify="between">
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: 16,
            backgroundColor: c.background,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name={TOAST_ICON[item.tone]} size={16} color={c.text} />
        </View>
        <Text style={{ flexShrink: 1, flexGrow: 1 }}>{item.message}</Text>
        <Button
          variant="ghost"
          size="sm"
          icon="x"
          accessibilityLabel="Dismiss message"
          onPress={() => onDismiss(item.id)}
        />
      </Stack>
    </View>
  );
}
