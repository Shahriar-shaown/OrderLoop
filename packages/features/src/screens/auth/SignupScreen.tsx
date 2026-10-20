import { RegisterBody } from '@orderloop/contracts';
import { Button, Form, Link, Text, useNavigation } from '@orderloop/ui';
import { useEffect } from 'react';
import { useAuth } from '../../core/auth';
import { useRuntime } from '../../core/runtime';
import { AuthLayout } from '../../shell/AuthLayout';
import { FormError } from '../../forms/FormError';
import { FormPasswordField } from '../../forms/FormPasswordField';
import { FormTextField } from '../../forms/FormTextField';
import { useZodForm } from '../../forms/zodForm';

export function SignupScreen() {
  const { status, signUp } = useAuth();
  const navigation = useNavigation();
  const { home } = useRuntime();
  const form = useZodForm(RegisterBody, { name: '', tenantName: '', email: '', password: '' });

  useEffect(() => {
    if (status === 'authenticated' && !form.formState.isSubmitting) navigation.replace(home);
  }, [status]);

  const submit = form.submit(async (data) => {
    await signUp(data);
    navigation.replace(home);
  });

  return (
    <AuthLayout
      title="Create your account"
      description="Set up your business in a minute. You can invite your team later."
      footer={
        <Text tone="muted">
          Already have an account? <Link href="/login">Sign in</Link>
        </Text>
      }
    >
      <Form onSubmit={submit}>
        <FormError message={form.formError} />
        <FormTextField
          control={form.control}
          name="name"
          label="Your name"
          autoComplete="name"
          required
        />
        <FormTextField
          control={form.control}
          name="tenantName"
          label="Business name"
          autoComplete="organization"
          required
          hint="Your shop or company. You can invite your team later."
        />
        <FormTextField control={form.control} name="email" label="Email" kind="email" required />
        <FormPasswordField
          control={form.control}
          name="password"
          label="Password"
          kind="newPassword"
          required
          hint="At least 8 characters, with an uppercase letter, a number and a special character."
        />
        <Button type="submit" size="lg" loading={form.formState.isSubmitting} fullWidth>
          Create account
        </Button>
      </Form>
    </AuthLayout>
  );
}
