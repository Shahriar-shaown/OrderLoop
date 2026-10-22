import { ApiError } from '@orderloop/api-client';
import {
  Badge,
  Button,
  KeyValueList,
  PageHeader,
  Section,
  Stack,
  Text,
  useNavigation,
  useToast,
} from '@orderloop/ui';
import { useState } from 'react';
import { useAuth } from '../../core/auth';
import { useRuntime } from '../../core/runtime';
import { DangerDialog } from '../../forms/DangerDialog';
import { useTenantDeletion } from '../../lib/deletion';

const ROLE: Record<string, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  STAFF: 'Staff',
  ACCOUNTANT: 'Accountant',
};

/** The businesses that stand in the way of deleting an account, from the API's refusal. */
const blockers = (error: unknown): string[] =>
  error instanceof ApiError && error.code === 'account_delete_blocked'
    ? (error.errors ?? []).filter((e) => e.path === 'businesses').map((e) => e.message)
    : [];

/**
 * The person's own account: who they are, and the one irreversible thing they can do with it, delete it. Deleting asks for the
 * password again, explains what is removed and what stays, and says which businesses block it.
 */
export function AccountScreen() {
  const { session } = useAuth();
  const { api, session: manager } = useRuntime();
  const navigation = useNavigation();
  const toast = useToast();
  const grace = useTenantDeletion();
  const [open, setOpen] = useState(false);
  if (!session) return null;
  const graceDays = grace.data?.graceDays ?? 14;

  async function deleteAccount(password: string) {
    const result = await api.deleteAccount({ password, confirm: 'DELETE' });
    const scheduled = result.businessesScheduled.length;
    toast.success(
      scheduled > 0
        ? `Your account was deleted. ${scheduled} business(es) you were the only member of will be deleted for good.`
        : 'Your account was deleted.',
    );
    // The server ended every session already; this clears the screens' copy and returns to sign-in.
    await manager.logout().catch(() => undefined);
    navigation.replace('/login');
  }

  return (
    <Stack gap={5}>
      <PageHeader
        title="Your account"
        description="Your sign-in, and what happens if you delete it."
      />
      <Section title="You">
        <KeyValueList
          layout="inline"
          items={[
            { label: 'Name', value: session.user.name },
            { label: 'Email', value: session.user.email },
            {
              label: 'Role here',
              value: <Badge>{ROLE[session.role] ?? session.role}</Badge>,
            },
          ]}
        />
      </Section>
      <Section
        title="Delete my account"
        description="Remove your sign-in and your personal details from OrderLoop."
      >
        <Stack gap={3}>
          <Text tone="muted">
            Deleting your account signs you out everywhere and removes your name, email, password,
            registered phones and notification settings. It cannot be undone, and you can register
            the same email again afterwards as a new account. Records your businesses made keep your
            user id but no longer show your name.
          </Text>
          <Text tone="muted">
            {`A business you are the only member of is deleted for good after ${graceDays} days, and nobody can cancel that once you are gone. If you are the only owner of a business that has other members, make someone else an owner or remove the other members first.`}
          </Text>
          <Stack direction="row">
            <Button variant="danger" icon="trash" onPress={() => setOpen(true)}>
              Delete my account
            </Button>
          </Stack>
        </Stack>
        <DangerDialog
          open={open}
          title="Delete your account?"
          submitLabel="Delete my account"
          confirmText={{ label: 'Type DELETE to confirm', expected: 'DELETE' }}
          password
          failureDetail={(error) =>
            blockers(error).length > 0 ? (
              <Stack gap={1}>
                <Text weight="bold">Businesses that need another owner:</Text>
                {blockers(error).map((name) => (
                  <Text key={name}>{`• ${name}`}</Text>
                ))}
              </Stack>
            ) : null
          }
          onSubmit={({ password }) => deleteAccount(password)}
          onClose={() => setOpen(false)}
        >
          <Text>
            Your account will be deleted and you will be signed out everywhere. It cannot be undone.
          </Text>
        </DangerDialog>
      </Section>
    </Stack>
  );
}
