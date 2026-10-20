import type { ReactNode } from 'react';
import { Alert } from '../feedback/Alert';
import { Button } from '../Button';
import { Dialog } from './Dialog';
import type { IconName } from '../feedback/icons';
import { Form } from '../inputs/Form';
import { Stack } from '../layout/Stack';
import type { Tone } from '../theme/tokens';

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
