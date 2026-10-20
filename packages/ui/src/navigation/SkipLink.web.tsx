import { createElement } from 'react';
import type { SkipLinkProps } from './skipLinkTypes';

/** "Skip to content": the first thing a keyboard user can reach, jumping over the menu. Shown only while focused. */
export function SkipLink({ targetId = 'main', label = 'Skip to content' }: SkipLinkProps) {
  return createElement('a', { href: `#${targetId}`, className: 'ol-skip' }, label);
}
