import type { Metadata } from 'next';
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
    <html lang="en">
      <body>
        <RNWRegistry>
          <Providers>{children}</Providers>
        </RNWRegistry>
      </body>
    </html>
  );
}
