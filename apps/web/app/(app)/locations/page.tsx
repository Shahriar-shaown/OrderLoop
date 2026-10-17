import type { Metadata } from 'next';
import { LocationsScreen } from '@/components/screens';

export const metadata: Metadata = { title: 'Locations' };

export default function Page() {
  return <LocationsScreen />;
}
