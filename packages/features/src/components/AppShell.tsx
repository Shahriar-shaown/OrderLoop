import type { Permission } from '@orderloop/contracts';
import {
  Alert,
  Badge,
  Button,
  Link,
  LoadingState,
  NavLink,
  Row,
  Screen,
  SkipLink,
  Stack,
  Text,
  ThemeToggle,
  useNavigation,
  useTheme,
  useToast,
} from '@orderloop/ui';
import { useEffect, useState, type ReactNode } from 'react';
import { useWindowDimensions, View } from 'react-native';
import { useAuth, useRequireAuth } from '../auth';
import { messageFor } from '../errors';
import { useCan } from '../permissions';
import { useRuntime } from '../runtime';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

export interface ShellNavItem {
  href: string;
  label: string;
  needs?: Permission;
}

const WEB_NAV: ShellNavItem[] = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/orders', label: 'Orders' },
  { href: '/customers', label: 'Customers' },
  { href: '/products', label: 'Products' },
  { href: '/inventory', label: 'Stock' },
  { href: '/categories', label: 'Categories' },
  { href: '/locations', label: 'Locations' },
  { href: '/suppliers', label: 'Suppliers' },
  { href: '/imports', label: 'Import', needs: 'catalog:write' },
  { href: '/finance', label: 'Finance', needs: 'finance:read' },
  { href: '/team', label: 'Team', needs: 'members:read' },
  { href: '/settings', label: 'Settings' },
];

function VerifyBanner() {
  const { session: current } = useAuth();
  const { api, session } = useRuntime();
  const toast = useToast();
  const [busy, setBusy] = useState<'resend' | 'check' | null>(null);
  if (!current || current.user.emailVerified) return null;

  async function resend() {
    setBusy('resend');
    try {
      await api.auth.resendVerification();
      toast.success('If a verification email was due, it is on its way. Check your inbox.');
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(null);
    }
  }
  async function check() {
    setBusy('check');
    try {
      const fresh = await session.refresh();
      if (fresh && !fresh.user.emailVerified) toast.error('Your email is not verified yet.');
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(null);
    }
  }
  return (
    <Alert
      tone="warning"
      action={
        <Row gap={2} wrap>
          <Button variant="secondary" size="sm" loading={busy === 'resend'} onPress={resend}>
            Resend verification email
          </Button>
          <Button variant="secondary" size="sm" loading={busy === 'check'} onPress={check}>
            I have verified
          </Button>
        </Row>
      }
    >
      <Text>
        Please verify your email address (<Text weight="bold">{current.user.email}</Text>). Some
        actions, like inviting people, need it.
      </Text>
    </Alert>
  );
}

/** The signed-in frame: header with the workspace and account, the menu, the verification reminder, then the screen. */
export function AppShell({
  children,
  nav = WEB_NAV,
}: {
  children: ReactNode;
  /** The menu. The web app shows the catalog; the mobile app shows what it has built so far. */
  nav?: ShellNavItem[];
}) {
  const { status, session: current, signOut } = useAuth();
  useRequireAuth();
  const navigation = useNavigation();
  const can = useCan();
  const { colors } = useTheme();
  const { home } = useRuntime();
  const [leaving, setLeaving] = useState(false);
  // On a phone the menu folds behind a button instead of wrapping into six rows.
  const { width } = useWindowDimensions();
  const narrow = width < 720;
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = navigation;
  useEffect(() => setMenuOpen(false), [pathname]);

  // While restoring the session (or being sent to sign in) show nothing from the app: no flash of private screens.
  if (status !== 'authenticated' || !current) {
    return (
      <Screen width="sm">
        <LoadingState label="Loading your workspace" />
      </Screen>
    );
  }

  async function leave() {
    setLeaving(true);
    await signOut();
    navigation.replace('/login');
  }

  return (
    <View style={{ flex: 1 }}>
      <SkipLink />
      <View
        role="banner"
        style={{
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
          paddingVertical: 12,
          paddingHorizontal: 16,
        }}
      >
        <View style={{ width: '100%', maxWidth: 1100, alignSelf: 'center' }}>
          <Stack direction="row" justify="between" align="center" gap={3} wrap>
            <Row gap={3} wrap>
              <Link href={home} variant="plain">
                <Text variant="heading">OrderLoop</Text>
              </Link>
              <WorkspaceSwitcher
                fallback={
                  <Text tone="muted" testID="tenant-name">
                    {current.tenant.name}
                  </Text>
                }
              />
              <Badge>{current.role.toLowerCase()}</Badge>
            </Row>
            <Row gap={3} wrap>
              <ThemeToggle />
              <Text tone="muted" testID="user-email">
                {current.user.email}
              </Text>
              <Button variant="secondary" size="sm" loading={leaving} onPress={leave}>
                Sign out
              </Button>
            </Row>
          </Stack>
          {narrow && (
            <View style={{ marginTop: 8, alignItems: 'flex-start' }}>
              <Button
                variant="secondary"
                size="sm"
                aria-expanded={menuOpen}
                aria-controls="main-menu"
                onPress={() => setMenuOpen((o) => !o)}
              >
                {menuOpen ? 'Close menu' : 'Menu'}
              </Button>
            </View>
          )}
          <View
            role="navigation"
            aria-label="Main"
            nativeID="main-menu"
            style={{ marginTop: 8, display: narrow && !menuOpen ? 'none' : 'flex' }}
          >
            <Row gap={1} wrap>
              {nav
                .filter((item) => !item.needs || can(item.needs))
                .map((item) => (
                  <NavLink key={item.href} href={item.href}>
                    {item.label}
                  </NavLink>
                ))}
            </Row>
          </View>
        </View>
      </View>
      <Screen>
        <Stack gap={5}>
          <VerifyBanner />
          {children}
        </Stack>
      </Screen>
    </View>
  );
}
