import { RegisterBody } from '@orderloop/contracts';
import { Button, Form, Link, Text, useNavigation } from '@orderloop/ui';
import { useEffect } from 'react';
import { useAuth } from '../auth';
import { AuthLayout } from '../components/AuthLayout';
import { FormError } from '../components/FormError';
import { FormTextField } from '../components/FormTextField';
import { useZodForm } from '../zodForm';

export function SignupScreen() {
  const { status, signUp } = useAuth();
  const navigation = useNavigation();
  const form = useZodForm(RegisterBody, { name: '', tenantName: '', email: '', password: '' });

  useEffect(() => {
    if (status === 'authenticated' && !form.formState.isSubmitting) navigation.replace('/products');
    // eslint-disable-next-line
  }, [status]);

  const submit = form.submit(async (data) => {
    await signUp(data);
    navigation.replace('/products');
  });

  return (
    <AuthLayout title="Create your account">
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
        <FormTextField
          control={form.control}
          name="password"
          label="Password"
          kind="newPassword"
          required
          hint="At least 8 characters, with an uppercase letter, a number and a special character."
        />
        <Button type="submit" loading={form.formState.isSubmitting} fullWidth>
          Create account
        </Button>
      </Form>
      <Text>
        Already have an account? <Link href="/login">Sign in</Link>
      </Text>
    </AuthLayout>
  );
}
