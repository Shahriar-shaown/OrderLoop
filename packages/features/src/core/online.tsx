import { useSyncExternalStore } from 'react';
import { alwaysOnline } from './connectivity';
import { useRuntime } from './runtime';

/** Whether the device is online, re-rendering when that changes. */
export function useOnline(): boolean {
  const connectivity = useRuntime().connectivity ?? alwaysOnline;
  return useSyncExternalStore(connectivity.subscribe, connectivity.isOnline, () => true);
}
