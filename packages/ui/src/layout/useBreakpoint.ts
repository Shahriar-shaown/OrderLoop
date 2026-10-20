import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { Dimensions, Platform } from 'react-native';
import { breakpoints } from '../theme/tokens';

export type Breakpoint = 'mobile' | 'tablet' | 'desktop';

/** A width of 0 means "not measured" (a test renderer, a window not laid out yet): treat it as a desktop, not a phone. */
const classify = (width: number): Breakpoint =>
  width <= 0 || width >= breakpoints.desktop
    ? 'desktop'
    : width >= breakpoints.tablet
      ? 'tablet'
      : 'mobile';

export interface Responsive {
  breakpoint: Breakpoint;
  width: number;
  isMobile: boolean;
  isTablet: boolean;
  isDesktop: boolean;
  /** Tablet and desktop: room for side-by-side layouts. */
  isWide: boolean;
  /** Fingers, not a mouse: any phone or tablet app, or a narrow browser window. Controls are then at least 44 pt. */
  isTouch: boolean;
}

function describe(width: number): Responsive {
  const breakpoint = classify(width);
  return {
    breakpoint,
    width,
    isMobile: breakpoint === 'mobile',
    isTablet: breakpoint === 'tablet',
    isDesktop: breakpoint === 'desktop',
    isWide: breakpoint !== 'mobile',
    isTouch: Platform.OS !== 'web' || breakpoint === 'mobile',
  };
}

/**
 * The window's width, followed. A browser's first render (on the server and on hydration) assumes desktop so that server
 * and browser markup agree; a phone knows its real width from the first frame.
 */
function useWindowWidth(enabled: boolean): number {
  const [width, setWidth] = useState<number>(() =>
    Platform.OS === 'web'
      ? breakpoints.desktop
      : Dimensions.get('window').width || breakpoints.desktop,
  );
  useEffect(() => {
    if (!enabled) return;
    setWidth(Dimensions.get('window').width || breakpoints.desktop);
    const sub = Dimensions.addEventListener('change', ({ window }) =>
      setWidth(window.width || breakpoints.desktop),
    );
    return () => sub.remove();
  }, [enabled]);
  return width;
}

const BreakpointContext = createContext<Responsive | null>(null);

/** One listener for the whole app: every component asks this provider instead of watching the window itself. */
export function BreakpointProvider({ children }: { children: ReactNode }) {
  const value = describe(useWindowWidth(true));
  return createElement(BreakpointContext.Provider, { value }, children);
}

/**
 * The layout class of the window: mobile (< 768), tablet (768–1279) or desktop (≥ 1280), as in the design. Inside a
 * `BreakpointProvider` it is shared; outside one (a test, a stray root) the component watches the window itself.
 */
export function useBreakpoint(): Responsive {
  const shared = useContext(BreakpointContext);
  const own = useWindowWidth(shared === null);
  return shared ?? describe(own);
}
