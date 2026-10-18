import { View, type ViewProps } from 'react-native';
import { layout, space } from './tokens';
import { useBreakpoint } from './useBreakpoint';

/** Content widths. `lg` is the design's 1128 px column plus its page margins. */
const WIDTHS = { sm: 440, md: 720, lg: layout.contentMax + 64, full: undefined } as const;

/** A centred column with a maximum width and the design's page margins (32 / 24 / 16 px): the frame every screen sits in. */
export function Container({
  width = 'lg',
  style,
  ...rest
}: ViewProps & { width?: keyof typeof WIDTHS }) {
  const { isMobile, isTablet } = useBreakpoint();
  return (
    <View
      style={[
        {
          width: '100%',
          alignSelf: 'center',
          paddingHorizontal: isMobile ? space[4] : isTablet ? space[6] : space[8],
          paddingVertical: isMobile ? space[4] : space[6],
          maxWidth: WIDTHS[width],
        },
        style,
      ]}
      {...rest}
    />
  );
}
