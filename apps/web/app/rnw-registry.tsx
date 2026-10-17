'use client';

import { useServerInsertedHTML } from 'next/navigation';
import { StyleSheet } from 'react-native';
import type { ReactNode } from 'react';

/**
 * react-native-web turns styles into CSS classes at render time. On the server those rules must be written into the HTML,
 * or the first paint is unstyled until the browser hydrates. This hands Next the collected rules as each chunk streams out.
 */
export function RNWRegistry({ children }: { children: ReactNode }) {
  useServerInsertedHTML(() => {
    const sheet = (
      StyleSheet as unknown as { getSheet(): { id: string; textContent: string } }
    ).getSheet();
    return <style id={sheet.id} dangerouslySetInnerHTML={{ __html: sheet.textContent }} />;
  });
  return <>{children}</>;
}
