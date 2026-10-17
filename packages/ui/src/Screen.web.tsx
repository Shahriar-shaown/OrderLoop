import type { ReactNode } from 'react';
import { Container } from './Container';

/** Web implementation: the document scrolls, so a nested scroll view would only get in the way. */
export function Screen({
  children,
  width,
}: {
  children: ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'full';
}) {
  return (
    <Container role="main" nativeID="main" {...(width ? { width } : {})}>
      {children}
    </Container>
  );
}
