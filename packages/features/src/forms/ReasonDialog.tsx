import { FormDialog, TextField } from '@orderloop/ui';
import { useFormState } from './forms';

/** Ask for a reason (at least 3 characters), then run `onSubmit`. Used for bulk cancellations. */
export function ReasonDialog({
  open,
  title,
  submitLabel,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  submitLabel: string;
  onSubmit: (reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const form = useFormState({ reason: '' });
  if (!open) return null;
  async function submit() {
    const reason = form.values.reason.trim();
    if (reason.length < 3) return form.setErrors({ reason: 'Say why (at least 3 characters)' });
    const ok = await form.run(() => onSubmit(reason));
    if (ok) onClose();
  }
  return (
    <FormDialog
      open
      onClose={onClose}
      title={title}
      onSubmit={submit}
      submitLabel={submitLabel}
      busy={form.busy}
      error={form.formError}
      size="sm"
    >
      <TextField label="Reason" required autoFocus {...form.field('reason')} />
    </FormDialog>
  );
}
