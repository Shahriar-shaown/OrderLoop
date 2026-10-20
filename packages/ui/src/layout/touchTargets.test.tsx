import { screen } from '@testing-library/react';
import { Platform } from 'react-native';
import { afterEach, describe, expect, it } from 'vitest';
import { renderUi } from '../../test/render';
import { QuantityStepper } from '../inputs/QuantityStepper';
import { SearchField } from '../inputs/SearchField';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { Tabs } from '../navigation/Tabs';
import { FilterChip } from '../overlays/FilterChip';

const popover = {
  open: false,
  onPress: () => undefined,
  'aria-haspopup': 'menu',
  'aria-expanded': false,
} as const;

function Controls() {
  return (
    <>
      <SegmentedControl
        label="Theme"
        value="a"
        onChange={() => undefined}
        segments={[{ value: 'a', label: 'Auto' }]}
      />
      <FilterChip text="Date" active={false} popover={popover} />
      <QuantityStepper value="1" onChange={() => undefined} label="Quantity" />
      <Tabs
        label="Tabs"
        value="a"
        onChange={() => undefined}
        items={[{ value: 'a', label: 'One' }]}
        variant="chips"
      />
      <SearchField label="Search" />
    </>
  );
}

const heights = () => ({
  segment: screen.getByRole('radio'),
  chip: screen.getByRole('button', { name: 'Date' }),
  quantity: screen.getByRole('textbox', { name: 'Quantity' }),
  tab: screen.getByRole('tab'),
  search: screen.getByRole('searchbox').parentElement!,
});

describe('touch targets', () => {
  const web = Platform.OS;
  afterEach(() => {
    Platform.OS = web;
  });

  it('are at least 44 pt in a tablet or phone app (isTouch), not only on a narrow window', () => {
    // A tablet app is wide (tablet breakpoint) but still operated with fingers.
    Platform.OS = 'ios';
    renderUi(<Controls />);
    for (const [name, el] of Object.entries(heights()))
      expect(getComputedStyle(el).minHeight, name).toBe('44px');
  });

  it('are compact for a mouse on a wide browser window', () => {
    renderUi(<Controls />);
    for (const [name, el] of Object.entries(heights()))
      expect(getComputedStyle(el).minHeight, name).not.toBe('44px');
  });
});
