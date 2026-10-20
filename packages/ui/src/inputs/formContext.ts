import { createContext, useContext, type ReactNode } from 'react';
import type { Space } from '../theme/tokens';

/** Shared by both Form implementations (native and web): the function that submits the surrounding form. */
export const FormContext = createContext<(() => void) | null>(null);

/** Used by Button (type="submit") and TextField (the keyboard's "done" key on native). Null outside a Form. */
export const useFormSubmit = () => useContext(FormContext);

export interface FormProps {
  onSubmit: () => void;
  children: ReactNode;
  /** Vertical space between children (a spacing token). */
  gap?: Space;
  accessibilityLabel?: string;
}
