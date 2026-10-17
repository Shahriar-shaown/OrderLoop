import { ForgotPasswordBody } from '@orderloop/contracts';
import { Alert, Button, Form, Link, Text } from '@orderloop/ui';
import { useState } from 'react';
import { AuthLayout } from '../components/AuthLayout';
import { FormError } from '../components/FormError';
import { FormTextField } from '../components/FormTextField';
import { useApi } from '../runtime';
import { useZodForm } from '../zodForm';

export function ForgotPasswordScreen() {
  const api = useApi();
  const form = useZodForm(ForgotPasswordBody, { email: '' });
  const [sent, setSent] = useState(false);

  const submit = form.submit(async (data) => {
    await api.auth.forgotPassword(data.email);
    setSent(true);
  });

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
        <FormTextField control={form.control} name="email" label="Email" kind="email" required />
        <Button type="submit" loading={form.formState.isSubmitting} fullWidth>
          Send reset link
        </Button>
      </Form>
      <Link href="/login">Back to sign in</Link>
    </AuthLayout>
  );
}
