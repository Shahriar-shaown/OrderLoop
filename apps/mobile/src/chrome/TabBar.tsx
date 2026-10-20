import { useCan, usePendingOrders, useAuth } from '@orderloop/features';
import { Icon, Text, useT, useTheme, type IconName } from '@orderloop/ui';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TABS } from '@/navigation';
import { CreateSheet } from './CreateSheet';

/** What the bar needs from the tab navigator (kept structural so the app need not depend on the navigator's own types). */
export interface TabBarProps {
  state: { index: number; routes: { key: string; name: string }[] };
  navigation: {
    navigate(name: string): void;
    emit(event: { type: 'tabPress'; target: string; canPreventDefault: true }): {
      defaultPrevented: boolean;
    };
  };
}

const BAR_HEIGHT = 58;

function Tab({
  label,
  icon,
  active,
  badge,
  onPress,
}: {
  label: string;
  icon: IconName;
  active: boolean;
  badge?: number | undefined;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const t = useT();
  const color = active ? colors.primary : colors.muted;
  return (
    <Pressable
      role="tab"
      aria-selected={active}
      aria-label={badge ? `${t(label)}, ${badge}` : t(label)}
      onPress={onPress}
      hitSlop={4}
      style={{ flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', gap: 3 }}
    >
      <View>
        <Icon name={icon} size={22} color={color} />
        {badge ? (
          <View
            style={{
              position: 'absolute',
              top: -5,
              right: -10,
              minWidth: 16,
              height: 16,
              borderRadius: 8,
              paddingHorizontal: 4,
              backgroundColor: colors.danger,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text
              variant="caption"
              style={{ color: colors.onPrimary, fontSize: 10, lineHeight: 12 }}
            >
              {badge > 99 ? '99+' : String(badge)}
            </Text>
          </View>
        ) : null}
      </View>
      <Text variant="caption" weight={active ? 'semibold' : 'medium'} style={{ color }}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * The bottom bar of the design: Home, Orders, a raised "+", Shipments, More. The "+" is not a screen: it opens the create
 * sheet. Orders shows how many are waiting to be confirmed.
 */
export function TabBar({ state, navigation }: TabBarProps) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const t = useT();
  const can = useCan();
  const { status } = useAuth();
  const pending = usePendingOrders(status === 'authenticated' && can('orders:read'));
  const [creating, setCreating] = useState(false);
  const canCreate = can('orders:write') || can('catalog:write');

  const press = (name: string, index: number, key: string) => {
    const event = navigation.emit({ type: 'tabPress', target: key, canPreventDefault: true });
    if (state.index !== index && !event.defaultPrevented) navigation.navigate(name);
  };
  const tabs = TABS.map((tab) => {
    const index = state.routes.findIndex((r) => r.name === tab.name);
    const route = state.routes[index];
    return route ? (
      <Tab
        key={tab.name}
        label={tab.label}
        icon={tab.icon}
        active={state.index === index}
        badge={tab.name === 'orders' ? pending.data : undefined}
        onPress={() => press(tab.name, index, route.key)}
      />
    ) : null;
  });

  return (
    <View
      role="tablist"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 8,
        paddingBottom: insets.bottom,
        minHeight: BAR_HEIGHT + insets.bottom,
        backgroundColor: colors.surface,
        borderTopWidth: 1,
        borderTopColor: colors.border,
      }}
    >
      {tabs.slice(0, 2)}
      <View style={{ width: 72, alignItems: 'center', justifyContent: 'center' }}>
        {canCreate && (
          <Pressable
            role="button"
            aria-label={t('Create')}
            aria-haspopup="menu"
            onPress={() => {
              if (Platform.OS !== 'web')
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setCreating(true);
            }}
            hitSlop={6}
            style={({ pressed }) => ({
              width: 56,
              height: 56,
              borderRadius: 28,
              marginTop: -22,
              backgroundColor: colors.primary,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.9 : 1,
              shadowColor: colors.primary,
              shadowOpacity: 0.35,
              shadowRadius: 10,
              shadowOffset: { width: 0, height: 4 },
              elevation: 6,
            })}
          >
            <Icon name="plus" size={26} color={colors.onPrimary} />
          </Pressable>
        )}
      </View>
      {tabs.slice(2)}
      <CreateSheet open={creating} onClose={() => setCreating(false)} />
    </View>
  );
}
