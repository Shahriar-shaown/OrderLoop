import { screen } from '@testing-library/react';
import { expect } from 'vitest';

const CONTROLS = [
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'switch',
  'radio',
  'combobox',
  'tab',
];

/**
 * Every control on the page can be found by a name a screen reader would say: no unlabelled icon button, box or switch.
 * (Roles are looked up by name, so an empty name fails here the same way it would for a person using VoiceOver or TalkBack.)
 */
export function expectNamedControls(): void {
  const unnamed: string[] = [];
  for (const role of CONTROLS)
    for (const el of screen.queryAllByRole(role)) {
      const name =
        el.getAttribute('aria-label') ??
        el.getAttribute('aria-labelledby') ??
        el.textContent?.trim() ??
        '';
      const labelled =
        name !== '' ||
        (el as HTMLInputElement).labels?.length ||
        el.getAttribute('placeholder') ||
        el.getAttribute('title');
      if (!labelled) unnamed.push(`${role}: ${el.outerHTML.slice(0, 120)}`);
    }
  expect(unnamed).toEqual([]);
}
