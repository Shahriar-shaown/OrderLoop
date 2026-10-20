import {
  Alert,
  Button,
  Logo,
  Menu,
  NavItem,
  Row,
  Screen,
  Sheet,
  SkipLink,
  Stack,
  Text,
  useBreakpoint,
  useNavigation,
  useTheme,
  useToast,
  layout,
} from '@orderloop/ui';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';
import { useAuth, useRequireAuth } from '../core/auth';
import { OfflineBanner } from './OfflineBanner';
import { RestoreFailed } from './RestoreFailed';
import { messageFor } from '../forms/errors';
import { useCan } from '../core/permissions';
import { useApi, useRuntime } from '../core/runtime';
import { AccountMenu } from './AccountMenu';
import { GlobalSearch, useSearchShortcut } from './GlobalSearch';
import { BOTTOM_HREFS, WEB_NAV, type ShellNavItem } from './nav';
import { WorkspaceMenu } from './WorkspaceMenu';

export type { ShellNavItem } from './nav';

export function VerifyBanner() {
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
        {`Please verify your email address (${current.user.email}). Some actions, like inviting people, need it.`}
      </Text>
    </Alert>
  );
}

/** Orders waiting to be confirmed: the one count the menu shows, because it is work a person has to do. */
export function usePendingOrders(enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ['orders', 'pending-count'],
    enabled,
    refetchInterval: 60_000,
    queryFn: async () =>
      (await api.orders.list({ limit: 1 } as never)).statusCounts['pending_confirmation'] ?? 0,
  });
}

const sticky = { position: 'sticky', top: 0 } as unknown as ViewStyle;

function QuickCreate({ compact }: { compact?: boolean }) {
  const can = useCan();
  const items = [
    ...(can('orders:write')
      ? [{ key: 'order', label: 'New order', icon: 'box' as const, href: '/orders/new' }]
      : []),
    ...(can('catalog:write')
      ? [{ key: 'product', label: 'New product', icon: 'layers' as const, href: '/products/new' }]
      : []),
    ...(can('orders:write')
      ? [{ key: 'customer', label: 'New customer', icon: 'users' as const, href: '/customers' }]
      : []),
  ];
  if (!items.length) return null;
  return (
    <Menu
      items={items}
      width={220}
      triggerAlign="center"
      trigger={(p) => (
        <Button
          variant="secondary"
          icon="plus"
          iconRight={compact ? undefined : 'chevron-down'}
          onPress={p.onPress}
          aria-haspopup="menu"
          aria-expanded={p['aria-expanded']}
          accessibilityLabel="Quick create"
        >
          {compact ? undefined : 'Quick create'}
        </Button>
      )}
    />
  );
}

/** The signed-in frame: sidebar (rail on a tablet, bottom bar on a phone), header, the verification reminder, then the screen. */
export function AppShell({
  children,
  nav = WEB_NAV,
}: {
  children: ReactNode;
  /** The menu. The web app shows the whole catalogue; the mobile app shows what it has built so far. */
  nav?: ShellNavItem[];
}) {
  const { status, session: current, signOut, restoreFailed } = useAuth();
  useRequireAuth();
  const navigation = useNavigation();
  const can = useCan();
  const { colors } = useTheme();
  const { isMobile, isTablet, isDesktop } = useBreakpoint();
  const [leaving, setLeaving] = useState(false);
  const [searching, setSearching] = useState(false);
  const [more, setMore] = useState(false);
  const { pathname } = navigation;
  useEffect(() => setMore(false), [pathname]);
  const openSearch = useCallback(() => setSearching(true), []);
  useSearchShortcut(openSearch);
  const pending = usePendingOrders(status === 'authenticated' && can('orders:read'));

  // While restoring the session (or being sent to sign in) show nothing from the app: no flash of private screens.
  if (status !== 'authenticated' || !current) {
    if (restoreFailed)
      return (
        <Screen width="sm">
          <RestoreFailed />
        </Screen>
      );
    return (
      <Screen width="sm">
        <Stack align="center" gap={3} style={{ paddingTop: 80 }}>
          <Logo />
          <Text tone="muted">Loading your workspace…</Text>
        </Stack>
      </Screen>
    );
  }

  async function leave() {
    setLeaving(true);
    await signOut();
    navigation.replace('/login');
  }

  const items = nav.filter((item) => !item.needs || can(item.needs));
  const groups = [...new Set(items.map((i) => i.group ?? ''))];
  const withBadge = (i: ShellNavItem) => (i.href === '/orders' ? pending.data : undefined);

  const sidebar = !isMobile && (
    <View
      role="navigation"
      aria-label="Main"
      style={[
        {
          width: isDesktop ? layout.sidebar : layout.rail,
          height: '100vh' as unknown as number,
          borderRightWidth: 1,
          borderRightColor: colors.border,
          backgroundColor: colors.surface,
          paddingVertical: 16,
          paddingHorizontal: isDesktop ? 16 : 12,
          gap: 4,
        },
        sticky,
      ]}
    >
      <View
        style={{
          height: 40,
          justifyContent: 'center',
          paddingHorizontal: isDesktop ? 4 : 0,
          marginBottom: 12,
          alignItems: isDesktop ? 'flex-start' : 'center',
        }}
      >
        <Pressable
          role="link"
          aria-label="OrderLoop home"
          onPress={() => navigation.push('/dashboard')}
        >
          <Logo size={isDesktop ? 30 : 32} wordmark={isDesktop} />
        </Pressable>
      </View>
      {groups.map((g) => (
        <View key={g || 'all'} style={{ gap: 2, marginBottom: 12 }}>
          {g && isDesktop && (
            <Text
              variant="fine"
              tone="muted"
              style={{
                paddingHorizontal: 12,
                paddingVertical: 6,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
              }}
            >
              {g}
            </Text>
          )}
          {items
            .filter((i) => (i.group ?? '') === g)
            .map((i) => (
              <NavItem
                key={i.href}
                href={i.href}
                label={i.label}
                icon={i.icon ?? 'box'}
                collapsed={!isDesktop}
                badge={withBadge(i)}
              />
            ))}
        </View>
      ))}
    </View>
  );

  const header = (
    <View
      role="banner"
      style={[
        {
          height: isMobile ? layout.headerMobile : layout.header,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
          backgroundColor: colors.surface,
          paddingHorizontal: isMobile ? 12 : isTablet ? 24 : 32,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          zIndex: 5,
        },
        sticky,
      ]}
    >
      <WorkspaceMenu compact={isMobile} />
      {isDesktop ? (
        <Pressable
          role="button"
          aria-label="Search orders, customers, tracking IDs ⌘K"
          onPress={openSearch}
          style={{
            flexGrow: 1,
            flexShrink: 1,
            maxWidth: 440,
            minHeight: 40,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            borderWidth: 1,
            borderColor: colors.borderStrong,
            borderRadius: 8,
            paddingHorizontal: 12,
            backgroundColor: colors.surface,
          }}
        >
          <Text tone="muted" style={{ flexGrow: 1 }}>
            Search orders, customers, tracking IDs
          </Text>
          <View
            style={{
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: 6,
              paddingHorizontal: 6,
              backgroundColor: colors.subtle,
            }}
          >
            <Text variant="caption" style={{ color: colors.foreground, opacity: 0.8 }}>
              ⌘K
            </Text>
          </View>
        </Pressable>
      ) : null}
      <View style={{ flexGrow: 1 }} />
      {!isDesktop && (
        <Button variant="ghost" icon="search" accessibilityLabel="Search" onPress={openSearch} />
      )}
      {!isMobile && <QuickCreate compact={isTablet} />}
      <AccountMenu onSignOut={leave} leaving={leaving} />
    </View>
  );

  const bottom = isMobile && (
    <View
      role="navigation"
      aria-label="Main"
      style={[
        {
          height: layout.bottomBar,
          borderTopWidth: 1,
          borderTopColor: colors.border,
          backgroundColor: colors.surface,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-around',
          paddingHorizontal: 8,
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 10,
        } as unknown as ViewStyle,
      ]}
    >
      {BOTTOM_HREFS.slice(0, 2).map((href) => {
        const i = items.find((x) => x.href === href);
        return i ? <BottomItem key={href} item={i} /> : null;
      })}
      <Menu
        items={[
          ...(can('orders:write')
            ? [{ key: 'order', label: 'New order', icon: 'box' as const, href: '/orders/new' }]
            : []),
          ...(can('catalog:write')
            ? [
                {
                  key: 'product',
                  label: 'New product',
                  icon: 'layers' as const,
                  href: '/products/new',
                },
              ]
            : []),
        ]}
        align="start"
        trigger={(p) => (
          <Pressable
            role="button"
            aria-label="Create"
            aria-haspopup="menu"
            aria-expanded={p['aria-expanded']}
            onPress={p.onPress}
            style={{
              width: 48,
              height: 48,
              borderRadius: 24,
              backgroundColor: colors.primary,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ color: colors.onPrimary, fontSize: 24, lineHeight: 26 }}>+</Text>
          </Pressable>
        )}
      />
      {(() => {
        const i = items.find((x) => x.href === BOTTOM_HREFS[2]);
        return i ? <BottomItem item={i} /> : null;
      })()}
      <Pressable
        role="button"
        aria-label="More"
        onPress={() => setMore(true)}
        style={{
          minWidth: 56,
          minHeight: 48,
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2,
        }}
      >
        <Text variant="caption" tone="muted">
          •••
        </Text>
        <Text variant="caption" tone="muted">
          More
        </Text>
      </Pressable>
    </View>
  );

  return (
    <View style={{ flex: 1, flexDirection: 'row' }}>
      <SkipLink />
      {sidebar}
      <View style={{ flex: 1, minWidth: 0, backgroundColor: colors.background }}>
        {header}
        <Screen>
          <Stack gap={5} style={isMobile ? { paddingBottom: layout.bottomBar + 8 } : undefined}>
            <OfflineBanner />
            <VerifyBanner />
            {children}
          </Stack>
        </Screen>
      </View>
      {bottom}
      <Sheet open={more} onClose={() => setMore(false)} title="Menu">
        <Stack gap={1}>
          {items.map((i) => (
            <NavItem
              key={i.href}
              href={i.href}
              label={i.label}
              icon={i.icon ?? 'box'}
              badge={withBadge(i)}
              onNavigate={() => setMore(false)}
            />
          ))}
        </Stack>
      </Sheet>
      <GlobalSearch open={searching} onClose={() => setSearching(false)} />
    </View>
  );
}

function BottomItem({ item }: { item: ShellNavItem }) {
  return (
    <NavItem
      href={item.href}
      label={item.label.split(' ')[0] ?? item.label}
      icon={item.icon ?? 'box'}
      collapsed
    />
  );
}
