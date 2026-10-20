import { FormDialog, TextField, useToast } from '@orderloop/ui';
import { useEffect } from 'react';
import { useFormState } from './forms';

/** The one rule for a reason a person must give (a cancellation, a write-off, a manual match). */
export const REASON_ERROR = 'Say why (at least 3 characters)';
export const hasReason = (text: string): boolean => text.trim().length >= 3;

/**
 * Ask for a reason (at least 3 characters), then run `onSubmit`. If `onSubmit` throws, the dialog stays open and shows the
 * error with the reason still typed; on success it closes (and shows `success`, if given). Starts empty each time it opens.
 */
export function ReasonDialog({
  open = true,
  title,
  submitLabel = 'Confirm',
  label = 'Reason',
  success,
  danger,
  onSubmit,
  onClose,
}: {
  open?: boolean;
  title: string;
  submitLabel?: string;
  label?: string;
  success?: string;
  danger?: boolean;
  onSubmit: (reason: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const toast = useToast();
  const form = useFormState({ reason: '' });
  const { set, clear } = form;
  useEffect(() => {
    if (!open) {
      set('reason', '');
      clear();
    }
  }, [open, set, clear]);
  if (!open) return null;
  async function submit() {
    const reason = form.values.reason.trim();
    if (!hasReason(reason)) return form.setErrors({ reason: REASON_ERROR });
    const ok = await form.run(() => onSubmit(reason));
    if (ok) {
      if (success) toast.success(success);
      onClose();
    }
  }
  return (
    <FormDialog
      open
      onClose={onClose}
      title={title}
      onSubmit={submit}
      submitLabel={submitLabel}
      danger={danger ?? false}
      busy={form.busy}
      error={form.formError}
      size="sm"
    >
      <TextField label={label} required autoFocus {...form.field('reason')} />
    </FormDialog>
  );
}
