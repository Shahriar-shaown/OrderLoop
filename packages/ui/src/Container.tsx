import { View, type ViewProps } from 'react-native';
import { space } from './tokens';

const WIDTHS = { sm: 440, md: 720, lg: 1100, full: undefined } as const;

/** A centred column with a maximum width and page padding: the frame every screen sits in. */
export function Container({
  width = 'lg',
  style,
  ...rest
}: ViewProps & { width?: keyof typeof WIDTHS }) {
  return (
    <View
      style={[
        {
          width: '100%',
          alignSelf: 'center',
          paddingHorizontal: space[4],
          paddingVertical: space[6],
          maxWidth: WIDTHS[width],
        },
        style,
      ]}
      {...rest}
    />
  );
}
