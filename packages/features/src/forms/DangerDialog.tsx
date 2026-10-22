import { ApiError } from '@orderloop/api-client';
import { FormDialog, Stack, TextField, useToast } from '@orderloop/ui';
import { useEffect, useState, type ReactNode } from 'react';
import { useFormState } from './forms';

export const PASSWORD_ERROR = 'Enter your password';
export const WRONG_PASSWORD = 'Incorrect password.';

/**
 * Confirm something that cannot be undone, the same way everywhere (erasing a customer, deleting an account, deleting a
 * business): what it does is written in `children`, the person types a word or a name exactly, optionally gives their
 * password again, and only then is `onSubmit` called. A failure leaves the dialog open with what was typed; a wrong password
 * is shown on the password box. Starts empty each time it opens.
 */
export function DangerDialog({
  open = true,
  title,
  children,
  submitLabel,
  confirmText,
  password = false,
  reason,
  success,
  failureDetail,
  onSubmit,
  onClose,
}: {
  open?: boolean;
  title: string;
  /** What will happen, in plain words. */
  children: ReactNode;
  submitLabel: string;
  /** The person must type `expected` exactly (after trimming) in a box called `label`. */
  confirmText?: { label: string; expected: string; hint?: string };
  /** Ask for the password again. */
  password?: boolean;
  /** An optional note for the record. */
  reason?: { label: string; hint?: string };
  /** Shown as a toast when it worked. */
  success?: string;
  /** Extra content under the error summary, made from the failure (for example the businesses that block an account deletion). */
  failureDetail?: (error: unknown) => ReactNode;
  onSubmit: (values: { password: string; reason: string }) => Promise<unknown>;
  onClose: () => void;
}) {
  const toast = useToast();
  const form = useFormState({ typed: '', password: '', reason: '' });
  const { set, clear } = form;
  const [failure, setFailure] = useState<unknown>(null);
  useEffect(() => {
    if (!open) {
      set('typed', '');
      set('password', '');
      set('reason', '');
      clear();
      setFailure(null);
    }
  }, [open, set, clear]);
  // Editing the password or the typed word retires a failure that was about the old text.
  const { password: typedPassword, typed } = form.values;
  useEffect(() => setFailure(null), [typedPassword, typed]);
  if (!open) return null;

  async function submit() {
    const errors: Record<string, string> = {};
    if (confirmText && form.values.typed.trim() !== confirmText.expected)
      errors['typed'] = `Type ${confirmText.expected} exactly as shown`;
    if (password && form.values.password === '') errors['password'] = PASSWORD_ERROR;
    if (Object.keys(errors).length > 0) return form.setErrors(errors);
    setFailure(null);
    const ok = await form.run(async () => {
      try {
        await onSubmit({ password: form.values.password, reason: form.values.reason.trim() });
      } catch (error) {
        setFailure(error);
        throw error;
      }
    });
    if (ok) {
      if (success) toast.success(success);
      onClose();
    }
  }

  const wrongPassword = failure instanceof ApiError && failure.code === 'invalid_credentials';
  return (
    <FormDialog
      open
      onClose={onClose}
      title={title}
      onSubmit={submit}
      submitLabel={submitLabel}
      danger
      busy={form.busy}
      error={wrongPassword ? '' : form.formError}
      size="sm"
    >
      <Stack gap={3}>
        {children}
        {failure !== null && !wrongPassword ? failureDetail?.(failure) : null}
        {confirmText ? (
          <TextField
            label={confirmText.label}
            required
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            hint={confirmText.hint}
            {...form.field('typed')}
          />
        ) : null}
        {password ? (
          <TextField
            label="Your password"
            kind="password"
            required
            {...form.field('password')}
            error={wrongPassword ? WRONG_PASSWORD : form.errors['password']}
          />
        ) : null}
        {reason ? (
          <TextField label={reason.label} hint={reason.hint} {...form.field('reason')} />
        ) : null}
      </Stack>
    </FormDialog>
  );
}
