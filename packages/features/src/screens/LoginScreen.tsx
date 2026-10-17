import { LoginBody } from '@orderloop/contracts';
import { Button, Form, Link, Row, TextField, useNavigation } from '@orderloop/ui';
import { useEffect } from 'react';
import { useAuth } from '../auth';
import { AuthLayout } from '../components/AuthLayout';
import { FormError } from '../components/FormError';
import { safeNext } from '../errors';
import { useFormState } from '../forms';

export function LoginScreen({ next }: { next?: string | undefined }) {
  const { status, signIn } = useAuth();
  const navigation = useNavigation();
  const target = safeNext(next);
  const form = useFormState({ email: '', password: '' });

  useEffect(() => {
    if (status === 'authenticated') navigation.replace(target);
  }, [status, target]);

  async function submit() {
    const data = form.check(LoginBody, form.values);
    if (!data) return;
    if (await form.run(() => signIn(data))) navigation.replace(target);
  }

  return (
    <AuthLayout title="Sign in">
      <Form onSubmit={submit}>
        <FormError message={form.formError} />
        <TextField label="Email" kind="email" required {...form.field('email')} />
        <TextField label="Password" kind="password" required {...form.field('password')} />
        <Button type="submit" loading={form.busy} fullWidth>
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
