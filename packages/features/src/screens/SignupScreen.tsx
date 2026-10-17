import { RegisterBody } from '@orderloop/contracts';
import { Button, Form, Link, Text, TextField, useNavigation } from '@orderloop/ui';
import { useEffect } from 'react';
import { useAuth } from '../auth';
import { AuthLayout } from '../components/AuthLayout';
import { FormError } from '../components/FormError';
import { useFormState } from '../forms';

export function SignupScreen() {
  const { status, signUp } = useAuth();
  const navigation = useNavigation();
  const form = useFormState({ name: '', tenantName: '', email: '', password: '' });

  useEffect(() => {
    if (status === 'authenticated' && !form.busy) navigation.replace('/products');
  }, [status]);

  async function submit() {
    const data = form.check(RegisterBody, form.values);
    if (!data) return;
    if (await form.run(() => signUp(data))) navigation.replace('/products');
  }

  return (
    <AuthLayout title="Create your account">
      <Form onSubmit={submit}>
        <FormError message={form.formError} />
        <TextField label="Your name" autoComplete="name" required {...form.field('name')} />
        <TextField
          label="Business name"
          autoComplete="organization"
          required
          hint="Your shop or company. You can invite your team later."
          {...form.field('tenantName')}
        />
        <TextField label="Email" kind="email" required {...form.field('email')} />
        <TextField
          label="Password"
          kind="newPassword"
          required
          hint="At least 10 characters."
          {...form.field('password')}
        />
        <Button type="submit" loading={form.busy} fullWidth>
          Create account
        </Button>
      </Form>
      <Text>
        Already have an account? <Link href="/login">Sign in</Link>
      </Text>
    </AuthLayout>
  );
}
