import { Pressable, View } from 'react-native';
import { Icon } from './Icon';
import type { IconName } from './icons';
import { useLinkPress, webLinkProps } from './Link';
import { useNavigation } from './navigation';
import { Text } from './Text';
import { useTheme } from './theme';
import { radius, space } from './tokens';

/**
 * One entry of the side navigation: an icon, a label, an optional count, and the active tint. `collapsed` shows only the icon
 * (the tablet rail) with the label as its accessible name and tooltip. It marks itself current (`aria-current="page"`) when
 * the path matches.
 */
export function NavItem({
  href,
  label,
  icon,
  badge,
  collapsed = false,
  onNavigate,
  exact = false,
}: {
  href: string;
  label: string;
  icon: IconName;
  badge?: number | undefined;
  collapsed?: boolean;
  onNavigate?: () => void;
  exact?: boolean;
}) {
  const { pathname } = useNavigation();
  const { colors } = useTheme();
  const follow = useLinkPress(href, false, onNavigate);
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Pressable
      role="link"
      aria-current={active ? 'page' : undefined}
      aria-label={collapsed ? label : undefined}
      {...webLinkProps(href)}
      {...(collapsed ? ({ title: label } as object) : {})}
      onPress={follow}
      style={(state) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: space[3],
          minHeight: 40,
          paddingHorizontal: collapsed ? 0 : space[3],
          justifyContent: collapsed ? 'center' : 'flex-start',
          borderRadius: radius.md,
          backgroundColor: active ? colors.primarySoft : 'transparent',
        },
        (state as { hovered?: boolean }).hovered && !active
          ? { backgroundColor: colors.subtle }
          : null,
        (state as { focused?: boolean }).focused
          ? ({ outlineWidth: 3, outlineStyle: 'solid', outlineColor: colors.focus } as object)
          : null,
      ]}
    >
      <Icon name={icon} size={18} color={active ? colors.primary : colors.muted} />
      {!collapsed && (
        <>
          <Text
            variant="label"
            style={{
              flexGrow: 1,
              flexShrink: 1,
              color: active ? colors.primary : colors.foreground,
            }}
          >
            {label}
          </Text>
          {badge !== undefined && badge > 0 && (
            <View
              style={{
                borderRadius: radius.full,
                paddingHorizontal: 7,
                minWidth: 22,
                alignItems: 'center',
                backgroundColor: active ? colors.primary : colors.subtle,
              }}
            >
              <Text
                variant="fine"
                numeric
                style={{ color: active ? colors.onPrimary : colors.muted }}
              >
                {badge}
              </Text>
            </View>
          )}
        </>
      )}
    </Pressable>
  );
}
