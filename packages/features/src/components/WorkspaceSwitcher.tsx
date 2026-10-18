import { SelectField, useNavigation, useToast } from '@orderloop/ui';
import { useState, type ReactNode } from 'react';
import { useAuth } from '../auth';
import { useRuntime } from '../runtime';
import { messageFor } from '../errors';
import { useSwitchWorkspace, useWorkspaces } from '../workspaces';

const NEW = '__new__';

/** Pick which of your businesses you are working in. Always asks the API, which re-checks that you belong to it. */
export function WorkspaceSwitcher({ fallback }: { fallback: ReactNode }) {
  const { session } = useAuth();
  const query = useWorkspaces();
  const switchTo = useSwitchWorkspace();
  const navigation = useNavigation();
  const { home } = useRuntime();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!session) return null;
  // With a single business there is nothing to switch between: show its name.
  if ((query.data?.length ?? 0) <= 1) return <>{fallback}</>;

  const options = [
    ...(query.data ?? []).map((w) => ({
      value: w.id,
      label: w.name,
    })),
    { value: NEW, label: '+ New business' },
  ];

  async function onChange(value: string) {
    if (value === NEW) {
      navigation.push('/workspaces/new');
      return;
    }
    if (value === session?.tenant.id) return;
    setBusy(true);
    try {
      await switchTo(value);
      navigation.replace(home);
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SelectField
      label="Business"
      hideLabel
      value={session.tenant.id}
      onChange={onChange}
      options={options}
      disabled={busy}
    />
  );
}
