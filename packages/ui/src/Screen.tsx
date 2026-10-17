import type { ReactNode } from 'react';
import { ScrollView } from 'react-native';
import { Container } from './Container';

/** Native implementation: a scrolling screen (the web page scrolls by itself, see Screen.web.tsx). */
export function Screen({
  children,
  width,
}: {
  children: ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'full';
}) {
  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1 }}>
      <Container role="main" nativeID="main" {...(width ? { width } : {})}>
        {children}
      </Container>
    </ScrollView>
  );
}
