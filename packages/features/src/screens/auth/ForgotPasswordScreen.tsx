import { ForgotPasswordBody } from '@orderloop/contracts';
import { Alert, Button, Form } from '@orderloop/ui';
import { useState } from 'react';
import { AuthLayout } from '../../shell/AuthLayout';
import { FormError } from '../../forms/FormError';
import { FormTextField } from '../../forms/FormTextField';
import { useApi } from '../../core/runtime';
import { useZodForm } from '../../forms/zodForm';

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
        <Button href="/login" variant="secondary" fullWidth>
          Back to sign in
        </Button>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout
      title="Reset your password"
      description="Enter your email and we will send you a link to choose a new password."
      footer={
        <Button href="/login" variant="link">
          Back to sign in
        </Button>
      }
    >
      <Form onSubmit={submit}>
        <FormError message={form.formError} />
        <FormTextField control={form.control} name="email" label="Email" kind="email" required />
        <Button type="submit" size="lg" loading={form.formState.isSubmitting} fullWidth>
          Send reset link
        </Button>
      </Form>
    </AuthLayout>
  );
}
