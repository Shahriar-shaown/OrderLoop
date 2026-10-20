import { Icon, Text, useLinkPress, useTheme, type IconName, useT } from '@orderloop/ui';
import { Pressable, View } from 'react-native';
import { useCan } from '../core/permissions';

function Tile({ label, icon, href }: { label: string; icon: IconName; href: string }) {
  const { colors } = useTheme();
  const follow = useLinkPress(href, false, undefined);
  const t = useT();
  return (
    <Pressable
      role="link"
      aria-label={t(label)}
      onPress={follow}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 76,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingVertical: 10,
        paddingHorizontal: 4,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: pressed ? colors.subtle : colors.surface,
      })}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 18,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.primarySoft,
        }}
      >
        <Icon name={icon} size={18} color={colors.primary} />
      </View>
      <Text variant="caption" weight="medium" align="center" numberOfLines={2}>
        {label}
      </Text>
    </Pressable>
  );
}

/** The phone's shortcuts on the overview (the design's row of four): what a person does most, one tap away. */
export function QuickActions() {
  const can = useCan();
  const tiles = [
    ...(can('orders:write')
      ? [{ label: 'New order', icon: 'plus' as const, href: '/orders/new' }]
      : []),
    ...(can('couriers:read')
      ? [{ label: 'Book courier', icon: 'truck' as const, href: '/couriers' }]
      : []),
    ...(can('catalog:write')
      ? [{ label: 'Add stock', icon: 'layers' as const, href: '/products' }]
      : []),
    ...(can('finance:read') ? [{ label: 'Reconcile', icon: 'wallet' as const, href: '/cod' }] : []),
  ];
  if (!tiles.length) return null;
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      {tiles.map((t) => (
        <Tile key={t.href} {...t} />
      ))}
    </View>
  );
}
