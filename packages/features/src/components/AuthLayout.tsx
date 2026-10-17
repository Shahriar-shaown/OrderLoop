import { Card, Link, Screen, SkipLink, Stack, Text } from '@orderloop/ui';
import type { ReactNode } from 'react';

/** The frame of every signed-out screen: the brand, and a card with the screen's title. */
export function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <SkipLink />
      <Screen width="sm">
        <Stack gap={6}>
          <Link href="/" variant="plain">
            <Text variant="display" align="center" role="presentation">
              OrderLoop
            </Text>
          </Link>
          <Card padding="lg">
            <Stack gap={4}>
              <Text variant="title" aria-level={1}>
                {title}
              </Text>
              {children}
            </Stack>
          </Card>
        </Stack>
      </Screen>
    </>
  );
}
