import type { ReactNode } from 'react';

/** Shared by Dialog (native) and Dialog.web. */
export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Buttons along the bottom edge. */
  footer?: ReactNode;
  size?: 'sm' | 'md';
}

export const DIALOG_WIDTHS = { sm: 400, md: 560 } as const;
