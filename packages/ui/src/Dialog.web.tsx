import { createElement, useEffect, useId, useRef } from 'react';
import { Content } from './Content';
import { Stack } from './Stack';
import { Text } from './Text';
import { space } from './tokens';
import { DIALOG_WIDTHS, type DialogProps } from './dialogTypes';

export type { DialogProps } from './dialogTypes';

type DialogElement = {
  open: boolean;
  showModal(): void;
  close(): void;
  querySelector(selector: string): { focus(): void } | null;
};

/**
 * Web implementation: the browser's own modal `<dialog>`. It traps keyboard focus inside, makes everything behind it inert,
 * sits above all other content, closes on Escape and returns focus to what opened it, so none of that is hand-built here.
 * The backdrop and box styling is in the theme stylesheet (cssVars.ts).
 */
export function Dialog({ open, onClose, title, children, footer, size = 'md' }: DialogProps) {
  const ref = useRef<DialogElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      // The browser focuses the first control (often a dropdown); a form is friendlier when typing can start at once.
      el.querySelector(
        'input:not([type=hidden]):not([disabled]), textarea:not([disabled])',
      )?.focus();
    }
    if (!open && el.open) el.close();
  }, [open]);

  // Keep the page behind from scrolling while the dialog is open.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  return createElement(
    'dialog',
    {
      ref,
      className: 'ol-dialog',
      'aria-labelledby': titleId,
      style: { maxWidth: DIALOG_WIDTHS[size] },
      // Escape: let our state decide, instead of the browser closing the element behind React's back.
      onCancel: (event: { preventDefault(): void }) => {
        event.preventDefault();
        onClose();
      },
      // A click on the backdrop (the dialog element itself, outside its content box) closes it.
      onClick: (event: { target: unknown; currentTarget: unknown }) => {
        if (event.target === event.currentTarget) onClose();
      },
    },
    open
      ? createElement(
          'div',
          { style: { maxHeight: '85vh', overflowY: 'auto', padding: space[5] } },
          <Stack gap={4}>
            <Text nativeID={titleId} variant="heading" role="heading" aria-level={2}>
              {title}
            </Text>
            <Content>{children}</Content>
            {footer && (
              <Stack direction="row" gap={2} justify="end" wrap>
                {footer}
              </Stack>
            )}
          </Stack>,
        )
      : null,
  );
}
