'use client';

import { CrashScreen } from '@/components/screens';

/** What Next shows when a screen throws while rendering (the same screen the mobile app shows). */
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return <CrashScreen retry={reset} />;
}
