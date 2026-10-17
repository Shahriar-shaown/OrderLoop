import { LoginBody } from '@orderloop/contracts';
import { Button, Form, Link, Row, useNavigation } from '@orderloop/ui';
import { useEffect } from 'react';
import { useAuth } from '../auth';
import { AuthLayout } from '../components/AuthLayout';
import { FormError } from '../components/FormError';
import { FormTextField } from '../components/FormTextField';
import { safeNext } from '../errors';
import { useZodForm } from '../zodForm';

export function LoginScreen({ next }: { next?: string | undefined }) {
  const { status, signIn } = useAuth();
  const navigation = useNavigation();
  const target = safeNext(next);
  const form = useZodForm(LoginBody, { email: '', password: '' });

  useEffect(() => {
    if (status === 'authenticated') navigation.replace(target);
  }, [status, target]);

  const submit = form.submit(async (data) => {
    await signIn(data);
    navigation.replace(target);
  });

  return (
    <AuthLayout title="Sign in">
      <Form onSubmit={submit}>
        <FormError message={form.formError} />
        <FormTextField control={form.control} name="email" label="Email" kind="email" required />
        <FormTextField
          control={form.control}
          name="password"
          label="Password"
          kind="password"
          required
        />
        <Button type="submit" loading={form.formState.isSubmitting} fullWidth>
          Sign in
        </Button>
      </Form>
      <Row justify="between" wrap gap={2}>
        <Link href="/forgot-password">Forgot your password?</Link>
        <Link href="/signup">Create an account</Link>
      </Row>
    </AuthLayout>
  );
}
