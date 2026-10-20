import type { ReactNode } from 'react';
import type { IconName } from '../feedback/icons';
import type { Tone } from '../theme/tokens';

/** Shared by Dialog (native) and Dialog.web. */
export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Buttons along the bottom edge. */
  footer?: ReactNode;
  size?: 'sm' | 'md';
  /** A round icon above the title (the design's confirm and cancel dialogs). */
  icon?: IconName;
  iconTone?: Tone;
}

export const DIALOG_WIDTHS = { sm: 400, md: 560 } as const;
