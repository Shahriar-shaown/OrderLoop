import { LoginBody } from '@orderloop/contracts';
import { Alert, Button, Form, Link, Row, Text, useNavigation } from '@orderloop/ui';
import { useEffect } from 'react';
import { useAuth } from '../../core/auth';
import { AuthLayout } from '../../shell/AuthLayout';
import { FormError } from '../../forms/FormError';
import { FormPasswordField } from '../../forms/FormPasswordField';
import { FormTextField } from '../../forms/FormTextField';
import { safeNext } from '../../forms/errors';
import { useRuntime } from '../../core/runtime';
import { useZodForm } from '../../forms/zodForm';

export function LoginScreen({ next }: { next?: string | undefined }) {
  const { status, signIn, endedBy } = useAuth();
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
        {endedBy === 'expired' && (
          <Alert tone="warning">Your session has expired. Sign in again to continue.</Alert>
        )}
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
