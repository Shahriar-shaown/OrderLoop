import { Alert, Button, Form, Link, Text, useNavigation } from '@orderloop/ui';
import { z } from 'zod';
import { useAuth } from '../auth';
import { AuthLayout } from '../components/AuthLayout';
import { FormError } from '../components/FormError';
import { FormTextField } from '../components/FormTextField';
import { useZodForm } from '../zodForm';

// The name is only needed for a brand-new account, so it may be left empty; when given it follows the sign-up rule.
const AcceptForm = z.object({
  name: z
    .string()
    .trim()
    .refine((v) => v === '' || v.length >= 3, 'Name must be at least 3 characters'),
  password: z.string().min(1, 'Password is required'),
});

export function AcceptInvitationScreen({ token }: { token?: string | undefined }) {
  const { acceptInvitation } = useAuth();
  const navigation = useNavigation();
  const form = useZodForm(AcceptForm, { name: '', password: '' });

  const submit = form.submit(async (data) => {
    await acceptInvitation({
      token: token ?? '',
      password: data.password,
      ...(data.name ? { name: data.name } : {}),
    });
    navigation.replace('/products');
  });

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
          <FormTextField
            control={form.control}
            name="name"
            label="Your name (new accounts only)"
            autoComplete="name"
          />
          <FormTextField
            control={form.control}
            name="password"
            label="Password"
            kind="password"
            required
          />
          <Button type="submit" loading={form.formState.isSubmitting} fullWidth>
            Join workspace
          </Button>
        </Form>
      )}
      <Link href="/login">Back to sign in</Link>
    </AuthLayout>
  );
}
