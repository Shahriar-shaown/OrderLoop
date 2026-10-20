import { SegmentedControl, type Segment } from '../inputs/SegmentedControl';
import { useThemePreference, type ThemePreference } from './theme';

const SEGMENTS: Segment<ThemePreference>[] = [
  { value: 'system', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** Switches between following the device (Auto), light and dark. The choice is remembered. */
export function ThemeToggle() {
  const { preference, setPreference } = useThemePreference();
  return (
    <SegmentedControl
      label="Colour theme"
      segments={SEGMENTS}
      value={preference}
      onChange={setPreference}
    />
  );
}
