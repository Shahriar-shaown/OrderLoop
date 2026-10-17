import { Password } from '@orderloop/contracts';
import { Alert, Button, Form, Link, Text, TextField } from '@orderloop/ui';
import { useState } from 'react';
import { z } from 'zod';
import { AuthLayout } from '../components/AuthLayout';
import { FormError } from '../components/FormError';
import { useFormState } from '../forms';
import { useApi } from '../runtime';

const ResetForm = z
  .object({ password: Password, confirm: z.string() })
  .refine((v) => v.password === v.confirm, {
    path: ['confirm'],
    message: 'The passwords do not match',
  });

export function ResetPasswordScreen({ token }: { token?: string | undefined }) {
  const api = useApi();
  const form = useFormState({ password: '', confirm: '' });
  const [done, setDone] = useState(false);

  async function submit() {
    const data = form.check(ResetForm, form.values);
    if (data && (await form.run(() => api.auth.resetPassword(token ?? '', data.password))))
      setDone(true);
  }

  if (!token) {
    return (
      <AuthLayout title="Reset your password">
        <Alert tone="error">
          This reset link is incomplete. Open the link from your email again, or request a new one.
        </Alert>
        <Link href="/forgot-password">Request a new link</Link>
      </AuthLayout>
    );
  }
  if (done) {
    return (
      <AuthLayout title="Password changed">
        <Alert tone="success">
          Your password has been changed and you were signed out everywhere. Sign in with the new
          one.
        </Alert>
        <Link href="/login">Go to sign in</Link>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title="Choose a new password">
      <Form onSubmit={submit}>
        <FormError message={form.formError} />
        {form.formError ? (
          <Text>
            <Link href="/forgot-password">Request a new link</Link>
          </Text>
        ) : null}
        <TextField
          label="New password"
          kind="newPassword"
          required
          hint="At least 10 characters."
          {...form.field('password')}
        />
        <TextField
          label="Confirm new password"
          kind="newPassword"
          required
          {...form.field('confirm')}
        />
        <Button type="submit" loading={form.busy} fullWidth>
          Change password
        </Button>
      </Form>
    </AuthLayout>
  );
}
