import { FormDialog, TextField, useToast, type IconName } from '@orderloop/ui';
import { useFormState } from './forms';
import { useIdempotencyKey } from './useIdempotencyKey';

function NameForm({
  title,
  label,
  initial,
  submitLabel,
  success,
  onSubmit,
  onClose,
  icon,
}: Omit<NameDialogProps, 'open'>) {
  const toast = useToast();
  const { key } = useIdempotencyKey();
  const form = useFormState({ name: initial });
  async function submit() {
    const name = form.values.name.trim();
    if (!name) return form.setErrors({ name: 'Enter a name' });
    if (await form.run(() => onSubmit(name, key))) {
      toast.success(success);
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
      busy={form.busy}
      error={form.formError}
      size="sm"
      {...(icon ? { icon } : {})}
    >
      <TextField label={label} autoFocus required {...form.field('name')} />
    </FormDialog>
  );
}

interface NameDialogProps {
  open: boolean;
  title: string;
  label: string;
  initial: string;
  submitLabel: string;
  /** The toast shown after saving. */
  success: string;
  /** `idempotencyKey` is the same for every retry from one opening of the dialog: pass it to the create call. */
  onSubmit: (name: string, idempotencyKey: string) => Promise<unknown>;
  onClose: () => void;
  /** A round icon above the title. */
  icon?: IconName;
}

/** A one-field dialog for creating or renaming something with a name (a category, a stock location). */
export function NameDialog({ open, ...rest }: NameDialogProps) {
  return open ? <NameForm key={rest.initial + rest.title} {...rest} /> : null;
}
