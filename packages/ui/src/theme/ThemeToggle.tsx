import { SegmentedControl } from '../inputs/SegmentedControl';
import { SelectMenu } from '../overlays/SelectMenu';
import { useThemePreference, type ThemePreference } from './theme';

const OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** Switches between following the device (Auto), light and dark, as a row of choices. The choice is remembered. */
export function ThemeToggle() {
  const { preference, setPreference } = useThemePreference();
  return (
    <SegmentedControl
      label="Colour theme"
      segments={OPTIONS}
      value={preference}
      onChange={setPreference}
    />
  );
}

/** The same choice as a compact dropdown, for a corner of a screen. */
export function ThemeSelect() {
  const { preference, setPreference } = useThemePreference();
  return (
    <SelectMenu
      label="Colour theme"
      options={OPTIONS}
      value={preference}
      onChange={setPreference}
    />
  );
}
