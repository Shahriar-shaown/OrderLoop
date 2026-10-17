import { ForgotPasswordBody } from '@orderloop/contracts';
import { Alert, Button, Form, Link, Text, TextField } from '@orderloop/ui';
import { useState } from 'react';
import { AuthLayout } from '../components/AuthLayout';
import { FormError } from '../components/FormError';
import { useFormState } from '../forms';
import { useApi } from '../runtime';

export function ForgotPasswordScreen() {
  const api = useApi();
  const form = useFormState({ email: '' });
  const [sent, setSent] = useState(false);

  async function submit() {
    const data = form.check(ForgotPasswordBody, form.values);
    if (data && (await form.run(() => api.auth.forgotPassword(data.email)))) setSent(true);
  }

  if (sent) {
    return (
      <AuthLayout title="Check your email">
        {/* The same wording whether or not the address has an account: the API never reveals which. */}
        <Alert tone="success">
          If an account exists for that address, we have sent a link to reset the password. It works
          once and expires in one hour.
        </Alert>
        <Link href="/login">Back to sign in</Link>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title="Reset your password">
      <Text tone="muted">
        Enter your email and we will send you a link to choose a new password.
      </Text>
      <Form onSubmit={submit}>
        <FormError message={form.formError} />
        <TextField label="Email" kind="email" required {...form.field('email')} />
        <Button type="submit" loading={form.busy} fullWidth>
          Send reset link
        </Button>
      </Form>
      <Link href="/login">Back to sign in</Link>
    </AuthLayout>
  );
}
