import { Children, type ReactNode } from 'react';
import { View } from 'react-native';
import { space } from './tokens';

/** Lays form fields in as many columns as fit (each at least `minWidth` wide), wrapping on narrow screens. */
export function FieldGrid({
  children,
  minWidth = 220,
}: {
  children: ReactNode;
  minWidth?: number;
}) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[3] }}>
      {Children.toArray(children).map((child, i) => (
        <View key={i} style={{ flexGrow: 1, flexBasis: minWidth, minWidth: 0 }}>
          {child}
        </View>
      ))}
    </View>
  );
}
