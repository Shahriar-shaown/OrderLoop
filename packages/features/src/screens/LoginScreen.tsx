import { LoginBody } from '@orderloop/contracts';
import { Button, Form, Link, Row, Text, useNavigation } from '@orderloop/ui';
import { useEffect } from 'react';
import { useAuth } from '../auth';
import { AuthLayout } from '../components/AuthLayout';
import { FormError } from '../components/FormError';
import { FormPasswordField } from '../components/FormPasswordField';
import { FormTextField } from '../components/FormTextField';
import { safeNext } from '../errors';
import { useRuntime } from '../runtime';
import { useZodForm } from '../zodForm';

export function LoginScreen({ next }: { next?: string | undefined }) {
  const { status, signIn } = useAuth();
  const navigation = useNavigation();
  const { home } = useRuntime();
  const target = safeNext(next, home);
  const form = useZodForm(LoginBody, { email: '', password: '' });

  useEffect(() => {
    if (status === 'authenticated') navigation.replace(target);
  }, [status, target]);

  const submit = form.submit(async (data) => {
    await signIn(data);
    navigation.replace(target);
  });

  return (
    <AuthLayout
      title="Sign in"
      description="Welcome back. Sign in to manage your orders, couriers and cash."
      footer={
        <Text tone="muted">
          New to OrderLoop? <Link href="/signup">Create an account</Link>
        </Text>
      }
    >
      <Form onSubmit={submit}>
        <FormError message={form.formError} />
        <FormTextField control={form.control} name="email" label="Email" kind="email" required />
        <FormPasswordField
          control={form.control}
          name="password"
          label="Password"
          kind="password"
          required
        />
        <Row justify="end">
          <Link href="/forgot-password">Forgot your password?</Link>
        </Row>
        <Button type="submit" size="lg" loading={form.formState.isSubmitting} fullWidth>
          Sign in
        </Button>
      </Form>
    </AuthLayout>
  );
}
