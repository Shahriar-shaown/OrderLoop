import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Platform, View, type ViewStyle } from 'react-native';
import { Button } from './Button';
import type { Tone } from './Badge';
import { Stack } from './Stack';
import { Text } from './Text';
import { useTheme } from './theme';
import { radius, space } from './tokens';

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
      {children}
      <View pointerEvents="box-none" style={HOST}>
        {items.map((t) => (
          <ToastView key={t.id} item={t} onDismiss={dismiss} />
        ))}
      </View>
    </ToastContext.Provider>
  );
}

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
        maxWidth: 520,
        width: '100%',
        backgroundColor: c.background,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: radius.md,
        padding: space[3],
      }}
    >
      <Stack direction="row" gap={3} align="center" justify="between">
        <Text style={{ color: c.text, flexShrink: 1 }}>{item.message}</Text>
        <Button
          variant="ghost"
          size="sm"
          onPress={() => onDismiss(item.id)}
          aria-label="Dismiss message"
        >
          Dismiss
        </Button>
      </Stack>
    </View>
  );
}
