import { Alert, Button, Form, useNavigation } from '@orderloop/ui';
import { z } from 'zod';
import { useAuth } from '../../core/auth';
import { useRuntime } from '../../core/runtime';
import { AuthLayout } from '../../shell/AuthLayout';
import { FormError } from '../../forms/FormError';
import { FormPasswordField } from '../../forms/FormPasswordField';
import { FormTextField } from '../../forms/FormTextField';
import { useZodForm } from '../../forms/zodForm';

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
  const { home } = useRuntime();
  const form = useZodForm(AcceptForm, { name: '', password: '' });

  const submit = form.submit(async (data) => {
    await acceptInvitation({
      token: token ?? '',
      password: data.password,
      ...(data.name ? { name: data.name } : {}),
    });
    navigation.replace(home);
  });

  return (
    <AuthLayout
      title="Accept your invitation"
      description={
        token
          ? 'You have been invited to join a business. New to OrderLoop? Enter your name and choose a password. Already have an account? Leave the name empty and enter your current password.'
          : undefined
      }
      footer={
        <Button href="/login" variant="link">
          Back to sign in
        </Button>
      }
    >
      {!token ? (
        <Alert tone="error">
          This invitation link is incomplete. Open the link from your email again.
        </Alert>
      ) : (
        <Form onSubmit={submit}>
          <FormError message={form.formError} />
          <FormTextField
            control={form.control}
            name="name"
            label="Your name (new accounts only)"
            autoComplete="name"
          />
          <FormPasswordField
            control={form.control}
            name="password"
            label="Password"
            kind="password"
            required
          />
          <Button type="submit" size="lg" loading={form.formState.isSubmitting} fullWidth>
            Join workspace
          </Button>
        </Form>
      )}
    </AuthLayout>
  );
}
