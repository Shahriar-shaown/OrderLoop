import { Password } from '@orderloop/contracts';
import { Alert, Button, Form } from '@orderloop/ui';
import { useState } from 'react';
import { z } from 'zod';
import { AuthLayout } from '../components/AuthLayout';
import { FormError } from '../components/FormError';
import { FormPasswordField } from '../components/FormPasswordField';
import { useApi } from '../runtime';
import { useZodForm } from '../zodForm';

const ResetForm = z
  .object({ password: Password, confirm: z.string().min(1, 'Confirm your password') })
  .refine((v) => v.password === v.confirm, {
    path: ['confirm'],
    message: 'The passwords do not match',
  });

export function ResetPasswordScreen({ token }: { token?: string | undefined }) {
  const api = useApi();
  const form = useZodForm(ResetForm, { password: '', confirm: '' });
  const [done, setDone] = useState(false);

  const submit = form.submit(async (data) => {
    await api.auth.resetPassword(token ?? '', data.password);
    setDone(true);
  });

  if (!token) {
    return (
      <AuthLayout title="Reset your password">
        <Alert tone="error">
          This reset link is incomplete. Open the link from your email again, or request a new one.
        </Alert>
        <Button href="/forgot-password" variant="secondary" fullWidth>
          Request a new link
        </Button>
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
        <Button href="/login" size="lg" fullWidth>
          Go to sign in
        </Button>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout
      title="Choose a new password"
      description="Pick something you do not use anywhere else."
      footer={
        form.formError ? (
          <Button href="/forgot-password" variant="link">
            Request a new link
          </Button>
        ) : undefined
      }
    >
      <Form onSubmit={submit}>
        <FormError message={form.formError} />
        <FormPasswordField
          control={form.control}
          name="password"
          label="New password"
          kind="newPassword"
          required
          hint="At least 8 characters, with an uppercase letter, a number and a special character."
        />
        <FormPasswordField
          control={form.control}
          name="confirm"
          label="Confirm new password"
          kind="newPassword"
          required
        />
        <Button type="submit" size="lg" loading={form.formState.isSubmitting} fullWidth>
          Change password
        </Button>
      </Form>
    </AuthLayout>
  );
}
