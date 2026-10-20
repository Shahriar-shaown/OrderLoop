import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { Button } from '../Button';
import { Icon } from '../feedback/Icon';
import type { IconName } from '../feedback/icons';
import { Link } from '../navigation/Link';
import { useNavigation } from '../navigation/navigation';
import { Popover, type PopoverTriggerProps } from './Popover';
import { Text } from '../Text';
import { useTheme } from '../theme/theme';
import { radius, space, touchTarget } from '../theme/tokens';
import { useBreakpoint } from '../layout/useBreakpoint';

export interface MenuItem {
  key: string;
  label: string;
  icon?: IconName;
  onPress?: () => void;
  /** Navigates (a real link on the web). */
  href?: string;
  /** Red, for the destructive item; it goes last, after a divider. */
  danger?: boolean;
  disabled?: boolean;
}

export function MenuRow({ item, onDone }: { item: MenuItem; onDone: () => void }) {
  const { colors } = useTheme();
  const nav = useNavigation();
  const { isTouch } = useBreakpoint();
  const ink = item.danger ? colors.danger : colors.foreground;
  return (
    <Pressable
      role="menuitem"
      aria-disabled={item.disabled || undefined}
      disabled={item.disabled}
      onPress={() => {
        onDone();
        if (item.href) nav.push(item.href);
        item.onPress?.();
      }}
      style={(state) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: space[3],
          minHeight: isTouch ? touchTarget : 40,
          paddingHorizontal: space[3],
          borderRadius: radius.md,
          opacity: item.disabled ? 0.5 : 1,
        },
        (state as { hovered?: boolean }).hovered || (state as { focused?: boolean }).focused
          ? { backgroundColor: colors.subtle }
          : null,
      ]}
    >
      {item.icon && (
        <Icon name={item.icon} size={16} color={item.danger ? colors.danger : colors.muted} />
      )}
      <Text variant="body" style={{ color: ink, flexShrink: 1 }}>
        {item.label}
      </Text>
    </Pressable>
  );
}

/**
 * A dropdown menu of actions. The destructive item (`danger`) is separated and last. Give it a `trigger`, usually an icon
 * button ("More actions"), or use `label` for a labelled button.
 */
export function Menu({
  items,
  trigger,
  label,
  triggerIcon = 'more',
  align = 'end',
  width = 220,
  triggerAlign,
}: {
  items: MenuItem[];
  trigger?: (props: PopoverTriggerProps) => ReactNode;
  /** Accessible name of the default icon button. */
  label?: string;
  triggerIcon?: IconName;
  align?: 'start' | 'end';
  width?: number;
  triggerAlign?: 'flex-start' | 'center' | 'flex-end';
}) {
  const { colors } = useTheme();
  const safe = items.filter((i) => !i.danger);
  const danger = items.filter((i) => i.danger);
  return (
    <Popover
      align={align}
      width={width}
      {...(triggerAlign ? { triggerAlign } : {})}
      trigger={
        trigger ??
        ((p) => (
          <Button
            variant="ghost"
            size="sm"
            icon={triggerIcon}
            accessibilityLabel={label ?? 'More actions'}
            onPress={p.onPress}
            aria-haspopup={p['aria-haspopup']}
            aria-expanded={p['aria-expanded']}
          />
        ))
      }
    >
      {(close) => (
        <View>
          {safe.map((i) => (
            <MenuRow key={i.key} item={i} onDone={close} />
          ))}
          {danger.length > 0 && safe.length > 0 && (
            <View
              role="separator"
              style={{ height: 1, backgroundColor: colors.border, marginVertical: 4 }}
            />
          )}
          {danger.map((i) => (
            <MenuRow key={i.key} item={i} onDone={close} />
          ))}
        </View>
      )}
    </Popover>
  );
}

void Link;
