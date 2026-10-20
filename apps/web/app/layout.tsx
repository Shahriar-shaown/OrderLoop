import type { Metadata } from 'next';
import { themeInitScript } from '@orderloop/ui/theme-script';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import { RNWRegistry } from './rnw-registry';
import '@fontsource-variable/inter';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'OrderLoop', template: '%s · OrderLoop' },
  description: 'One loop. Every order.',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The nonce proxy.ts made for this request: the theme script is inline, so it must carry it to be allowed to run.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    // suppressHydrationWarning: the script below may set data-scheme on <html> before React loads.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <RNWRegistry>
          <Providers>{children}</Providers>
        </RNWRegistry>
      </body>
    </html>
  );
}
