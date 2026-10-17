import type { Metadata } from 'next';
import { themeInitScript } from '@orderloop/ui/theme-script';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import { RNWRegistry } from './rnw-registry';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'OrderLoop', template: '%s · OrderLoop' },
  description: 'One loop. Every order.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: the script below may set data-scheme on <html> before React loads.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <RNWRegistry>
          <Providers>{children}</Providers>
        </RNWRegistry>
      </body>
    </html>
  );
}
