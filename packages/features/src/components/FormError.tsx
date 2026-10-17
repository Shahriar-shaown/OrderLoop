import { Alert } from '@orderloop/ui';

/** The summary line above a form when a request failed (field errors appear next to their fields). */
export function FormError({ message }: { message: string }) {
  return message ? <Alert tone="error">{message}</Alert> : null;
}
