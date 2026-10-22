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

/**
 * A control's accessible name must contain its visible text (WCAG 2.5.3, "label in name"), so someone who says "Sync now" to a
 * voice control finds the button. Checks every button and link that has both an aria-label and visible text.
 */
export function expectNamesContainVisibleText(): void {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const mismatched: string[] = [];
  for (const role of ['button', 'link', 'tab', 'checkbox', 'switch'])
    for (const el of screen.queryAllByRole(role)) {
      const label = el.getAttribute('aria-label');
      const text = norm(el.textContent ?? '');
      if (label && text && !norm(label).includes(text))
        mismatched.push(`${role} "${label}" does not contain its text "${text}"`);
    }
  expect(mismatched).toEqual([]);
}
