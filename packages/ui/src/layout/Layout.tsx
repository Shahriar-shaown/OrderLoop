import { Children, type ReactNode } from 'react';
import { View, type ViewStyle } from 'react-native';
import { layout, space } from '../theme/tokens';
import { useBreakpoint } from './useBreakpoint';

/** How many columns a grid has at each width. */
export interface Columns {
  mobile: number;
  tablet?: number;
  desktop?: number;
}

/**
 * A grid that reflows by breakpoint (KPI cards: 6 across on desktop, 3 × 2 on tablet, 2 × 3 on a phone). Children share the
 * width equally; the last row is left-aligned.
 */
export function Grid({
  columns,
  gap = 4,
  children,
}: {
  columns: Columns;
  gap?: 2 | 3 | 4 | 5 | 6;
  children: ReactNode;
}) {
  const { breakpoint } = useBreakpoint();
  const cols =
    breakpoint === 'desktop'
      ? (columns.desktop ?? columns.tablet ?? columns.mobile)
      : breakpoint === 'tablet'
        ? (columns.tablet ?? columns.mobile)
        : columns.mobile;
  const g = space[gap];
  const items = Children.toArray(children);
  return (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        marginHorizontal: -g / 2,
        marginVertical: -g / 2,
      }}
    >
      {items.map((child, i) => (
        <View
          key={i}
          style={{ width: `${100 / cols}%`, padding: g / 2, minWidth: 0, flexDirection: 'row' }}
        >
          <View style={{ flex: 1, minWidth: 0 }}>{child}</View>
        </View>
      ))}
    </View>
  );
}

/**
 * A main column with a side column (a summary, a detail panel). On desktop they sit side by side with a fixed-width aside
 * (the design's 360 px summary); on tablet and phone the aside goes underneath. `asideFirst` puts it first when stacked.
 */
export function Split({
  main,
  aside,
  asideWidth = 360,
  asideFirst = false,
  sticky = false,
}: {
  main: ReactNode;
  aside: ReactNode;
  asideWidth?: number;
  asideFirst?: boolean;
  /** Keep the aside in view while the main column scrolls (web). */
  sticky?: boolean;
}) {
  const { isDesktop } = useBreakpoint();
  if (!isDesktop)
    return (
      <View style={{ gap: space[4] }}>
        {asideFirst ? aside : null}
        {main}
        {asideFirst ? null : aside}
      </View>
    );
  return (
    <View style={{ flexDirection: 'row', gap: space[6], alignItems: 'flex-start' }}>
      <View style={{ flex: 1, minWidth: 0, gap: space[4] }}>{main}</View>
      <View
        style={[
          { width: asideWidth, gap: space[4] },
          sticky
            ? ({ position: 'sticky', top: layout.header + space[4] } as unknown as ViewStyle)
            : null,
        ]}
      >
        {aside}
      </View>
    </View>
  );
}

/** A vertical stack of page sections with the design's section gap. */
export function PageStack({ children }: { children: ReactNode }) {
  const { isMobile } = useBreakpoint();
  return <View style={{ gap: isMobile ? space[4] : space[6] }}>{children}</View>;
}
