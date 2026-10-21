import { useAuth, useCan, useDraftCount } from '@orderloop/features';
import {
  Avatar,
  Button,
  Card,
  LanguageToggle,
  NavItem,
  Stack,
  Text,
  ThemeToggle,
  useT,
} from '@orderloop/ui';
import Constants from 'expo-constants';
import { env } from '@/platform/env';
import { MORE_ITEMS } from '@/navigation';

const ROLE: Record<string, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  STAFF: 'Staff',
  ACCOUNTANT: 'Accountant',
};

/** The "More" tab: who is signed in, the rest of the app, the language and theme, and sign out. */
export function MoreScreen({ onSignOut }: { onSignOut: () => Promise<void> }) {
  const { session } = useAuth();
  const can = useCan();
  const t = useT();
  const drafts = useDraftCount(can('orders:read'));
  if (!session) return null;
  const version = Constants.expoConfig?.version ?? '';
  return (
    <Stack gap={5}>
      <Card variant="outlined" padding="md">
        <Stack direction="row" gap={3} align="center">
          <Avatar name={session.user.name} size={48} />
          <Stack gap={1} grow>
            <Text variant="title" role="none" numberOfLines={1}>
              {session.user.name}
            </Text>
            <Text tone="muted" numberOfLines={1}>
              {session.user.email}
            </Text>
            <Text variant="small" tone="muted" numberOfLines={1}>
              {`${session.tenant.name} · ${t(ROLE[session.role] ?? session.role)}`}
            </Text>
          </Stack>
        </Stack>
      </Card>

      <Card variant="outlined" padding="sm">
        <Stack gap={1}>
          {MORE_ITEMS.filter((i) => !i.needs || can(i.needs)).map((i) => (
            <NavItem
              key={i.href}
              href={i.href}
              label={i.label}
              icon={i.icon}
              badge={i.href === '/social-orders' ? drafts.data : undefined}
            />
          ))}
        </Stack>
      </Card>

      <Card variant="outlined" padding="md">
        <Stack gap={4}>
          <Stack gap={2}>
            <Text variant="label">Language</Text>
            <LanguageToggle />
          </Stack>
          <Stack gap={2}>
            <Text variant="label">Colour theme</Text>
            <ThemeToggle />
          </Stack>
        </Stack>
      </Card>

      <Button variant="secondary" size="lg" icon="logout" fullWidth onPress={onSignOut}>
        Sign out
      </Button>
      <Text variant="caption" tone="muted" align="center">
        {`OrderLoop ${version}${env.APP_ENV === 'production' ? '' : ` · ${env.APP_ENV} · ${new URL(env.API_URL).host}`}`}
      </Text>
    </Stack>
  );
}
