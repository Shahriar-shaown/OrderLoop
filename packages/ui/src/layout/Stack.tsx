import type { ReactNode } from 'react';
import { View, type ViewProps } from 'react-native';
import { space, type Space } from '../theme/tokens';
import { createVariants } from '../theme/variants';

const spaceVariants = Object.fromEntries(
  Object.entries(space).map(([key, value]) => [key, { gap: value }]),
);

const useStackStyle = createVariants(() => ({
  base: { minWidth: 0 },
  variants: {
    direction: { column: { flexDirection: 'column' }, row: { flexDirection: 'row' } },
    gap: spaceVariants,
    align: {
      start: { alignItems: 'flex-start' },
      center: { alignItems: 'center' },
      end: { alignItems: 'flex-end' },
      stretch: { alignItems: 'stretch' },
    },
    justify: {
      start: { justifyContent: 'flex-start' },
      center: { justifyContent: 'center' },
      end: { justifyContent: 'flex-end' },
      between: { justifyContent: 'space-between' },
    },
    // react-native-web views do not shrink by default, so a wrapping row must be told not to outgrow its parent.
    wrap: { true: { flexWrap: 'wrap', maxWidth: '100%' }, false: {} },
    grow: { true: { flexGrow: 1, flexShrink: 1, flexBasis: 0 }, false: {} },
  },
  defaults: { direction: 'column', gap: '0', wrap: 'false', grow: 'false' },
}));

export interface StackProps extends ViewProps {
  children?: ReactNode;
  direction?: 'column' | 'row';
  gap?: Space;
  align?: 'start' | 'center' | 'end' | 'stretch';
  justify?: 'start' | 'center' | 'end' | 'between';
  wrap?: boolean;
  /** Take the remaining space in a parent row. */
  grow?: boolean;
}

/** The layout primitive: a flex container with a spacing token for the gap. `Row` is `Stack direction="row"`. */
export function Stack({
  direction,
  gap,
  align,
  justify,
  wrap = false,
  grow = false,
  style,
  ...rest
}: StackProps) {
  const base = useStackStyle({
    direction,
    gap: gap === undefined ? undefined : (String(gap) as '0'),
    align,
    justify,
    wrap: String(wrap) as 'true',
    grow: String(grow) as 'true',
  });
  return <View style={[base, style]} {...rest} />;
}

export function Row(props: Omit<StackProps, 'direction'>) {
  return <Stack direction="row" align="center" {...props} />;
}
