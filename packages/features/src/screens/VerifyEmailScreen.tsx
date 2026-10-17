import { Alert, Link, LoadingState, Text } from '@orderloop/ui';
import { useEffect, useState } from 'react';
import { AuthLayout } from '../components/AuthLayout';
import { messageFor } from '../errors';
import { useRuntime } from '../runtime';

/**
 * Each link works once, so each token must be sent exactly once. React StrictMode runs effects twice in development; without
 * this per-token memo the second call would fail and overwrite the success message.
 */
const attempts = new Map<string, Promise<void>>();

type State = { kind: 'working' } | { kind: 'done' } | { kind: 'failed'; message: string };

export function VerifyEmailScreen({ token }: { token?: string | undefined }) {
  const { api, session } = useRuntime();
  const [state, setState] = useState<State>({ kind: 'working' });

  useEffect(() => {
    if (!token) return;
    let attempt = attempts.get(token);
    if (!attempt) {
      attempt = api.auth.verifyEmail(token).then(() => undefined);
      attempts.set(token, attempt);
    }
    let live = true;
    attempt.then(
      () => {
        if (!live) return;
        setState({ kind: 'done' });
        // If this device is signed in, pick up the now-verified state so the reminder banner disappears.
        if (session.getSnapshot().status === 'authenticated')
          session.refresh().catch(() => undefined);
      },
      (error: unknown) => live && setState({ kind: 'failed', message: messageFor(error) }),
    );
    return () => {
      live = false;
    };
  }, [token, api, session]);

  return (
    <AuthLayout title="Email verification">
      {!token ? (
        <Alert tone="error">
          This verification link is incomplete. Open the link from your email again.
        </Alert>
      ) : state.kind === 'working' ? (
        <LoadingState label="Verifying your email" />
      ) : state.kind === 'failed' ? (
        <>
          <Alert tone="error">{state.message}</Alert>
          <Text>Sign in and use “Resend verification email” to get a fresh link.</Text>
          <Link href="/login">Go to sign in</Link>
        </>
      ) : (
        <>
          <Alert tone="success">Your email address is verified. Thank you.</Alert>
          <Link href="/products">Continue to OrderLoop</Link>
        </>
      )}
    </AuthLayout>
  );
}
