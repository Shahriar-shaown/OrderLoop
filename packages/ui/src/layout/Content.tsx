import type { ReactNode } from 'react';
import { Text } from '../Text';

/** Plain text passed where a component takes content becomes a Text; anything else (elements) is used as given. */
export function Content({ children }: { children: ReactNode }) {
  return typeof children === 'string' || typeof children === 'number' ? (
    <Text>{children}</Text>
  ) : (
    <>{children}</>
  );
}
