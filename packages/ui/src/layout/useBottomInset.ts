import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** The strip at the bottom of the screen the system draws over (the home indicator, the gesture bar). Native; the web has none. */
export const useBottomInset = (): number => useSafeAreaInsets().bottom;
