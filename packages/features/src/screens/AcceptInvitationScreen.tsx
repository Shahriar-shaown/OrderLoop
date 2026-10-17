import { Alert, Button, Form, Link, Text, TextField, useNavigation } from '@orderloop/ui';
import { useAuth } from '../auth';
import { AuthLayout } from '../components/AuthLayout';
import { FormError } from '../components/FormError';
import { useFormState } from '../forms';

export function AcceptInvitationScreen({ token }: { token?: string | undefined }) {
  const { acceptInvitation } = useAuth();
  const navigation = useNavigation();
  const form = useFormState({ name: '', password: '' });

  async function submit() {
    const name = form.values.name.trim();
    const ok = await form.run(() =>
      acceptInvitation({
        token: token ?? '',
        password: form.values.password,
        ...(name ? { name } : {}),
      }),
    );
    if (ok) navigation.replace('/products');
  }

  return (
    <AuthLayout title="Accept your invitation">
      {!token ? (
        <Alert tone="error">
          This invitation link is incomplete. Open the link from your email again.
        </Alert>
      ) : (
        <Form onSubmit={submit}>
          <Text tone="muted">
            You have been invited to join a workspace. New to OrderLoop? Enter your name and choose
            a password. Already have an account? Leave the name empty and enter your current
            password.
          </Text>
          <FormError message={form.formError} />
          <TextField
            label="Your name (new accounts only)"
            autoComplete="name"
            {...form.field('name')}
          />
          <TextField label="Password" kind="password" required {...form.field('password')} />
          <Button type="submit" loading={form.busy} fullWidth>
            Join workspace
          </Button>
        </Form>
      )}
      <Link href="/login">Back to sign in</Link>
    </AuthLayout>
  );
}
