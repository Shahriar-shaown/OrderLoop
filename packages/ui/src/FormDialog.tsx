import type { ReactNode } from 'react';
import { Alert } from './Alert';
import { Button } from './Button';
import { Dialog } from './Dialog';
import type { IconName } from './icons';
import { Form } from './Form';
import { Stack } from './Stack';
import type { Tone } from './tokens';

/**
 * A dialog that is a form: fields, an error summary, Cancel and a submit button. The form lives inside the dialog (not
 * around it) so on the web it is a real `<form>` in the dialog's own DOM and Enter submits.
 */
export function FormDialog({
  open,
  onClose,
  title,
  onSubmit,
  submitLabel,
  busy = false,
  error,
  danger = false,
  children,
  size,
  icon,
  iconTone,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  onSubmit: () => void;
  submitLabel: string;
  busy?: boolean;
  error?: string;
  danger?: boolean;
  children: ReactNode;
  size?: 'sm' | 'md';
  /** A round icon above the title, as in the design's dialogs. */
  icon?: IconName;
  iconTone?: Tone;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      {...(size ? { size } : {})}
      {...(icon ? { icon } : {})}
      {...(iconTone ? { iconTone } : {})}
    >
      <Form onSubmit={onSubmit} accessibilityLabel={title}>
        {error ? <Alert tone="error">{error}</Alert> : null}
        {children}
        <Stack direction="row" gap={2} justify="end" wrap>
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant={danger ? 'danger' : 'primary'} loading={busy}>
            {submitLabel}
          </Button>
        </Stack>
      </Form>
    </Dialog>
  );
}
