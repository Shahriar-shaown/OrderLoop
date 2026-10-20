import { useEffect, useState } from 'react';
import { Dimensions, Platform } from 'react-native';
import { breakpoints } from './tokens';

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
}

/**
 * The layout class of the window: mobile (< 768), tablet (768–1279) or desktop (≥ 1280), as in the design. The first render
 * (on the server and on hydration) assumes desktop so server and browser markup agree; the real width is applied right after.
 */
export function useBreakpoint(): Responsive {
  // Only a browser has a server render to agree with; a phone knows its real width from the first frame.
  const [width, setWidth] = useState<number>(() =>
    Platform.OS === 'web'
      ? breakpoints.desktop
      : Dimensions.get('window').width || breakpoints.desktop,
  );
  useEffect(() => {
    setWidth(Dimensions.get('window').width || breakpoints.desktop);
    const sub = Dimensions.addEventListener('change', ({ window }) =>
      setWidth(window.width || breakpoints.desktop),
    );
    return () => sub.remove();
  }, []);
  const breakpoint = classify(width);
  return {
    breakpoint,
    width,
    isMobile: breakpoint === 'mobile',
    isTablet: breakpoint === 'tablet',
    isDesktop: breakpoint === 'desktop',
    isWide: breakpoint !== 'mobile',
  };
}
