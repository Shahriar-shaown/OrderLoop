import { Pressable, View } from 'react-native';
import { Icon } from '../feedback/Icon';
import { useBreakpoint } from '../layout/useBreakpoint';
import { Text } from '../Text';
import { useTheme } from '../theme/theme';
import { radius, space, touchTarget } from '../theme/tokens';
import { Popover } from './Popover';

export interface SelectMenuOption<T extends string> {
  value: T;
  label: string;
  /** Read by screen readers instead of `label`. */
  accessibilityLabel?: string;
}

/**
 * A quiet dropdown for a setting that is always there but rarely changed (theme, language): the current choice and a
 * chevron, and a short list that opens under it. `label` names the setting for screen readers.
 */
export function SelectMenu<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly SelectMenuOption<T>[];
  onChange: (value: T) => void;
}) {
  const { colors } = useTheme();
  const { isTouch } = useBreakpoint();
  const current = options.find((o) => o.value === value);
  return (
    <Popover
      haspopup="listbox"
      align="end"
      width={200}
      triggerAlign="center"
      trigger={(p) => (
        <Pressable
          role="combobox"
          aria-label={`${label}: ${current?.accessibilityLabel ?? current?.label ?? ''}`}
          aria-haspopup="listbox"
          aria-expanded={p['aria-expanded']}
          onPress={p.onPress}
          style={(state) => [
            {
              flexDirection: 'row',
              alignItems: 'center',
              gap: space[1],
              minHeight: isTouch ? touchTarget : 32,
              paddingHorizontal: space[2],
              borderRadius: radius.md,
            },
            (state as { hovered?: boolean }).hovered ? { backgroundColor: colors.subtle } : null,
            (state as { focused?: boolean }).focused
              ? ({ outlineWidth: 3, outlineStyle: 'solid', outlineColor: colors.focus } as object)
              : null,
          ]}
        >
          <Text variant="small" weight="medium" tone="muted" numberOfLines={1}>
            {current?.label}
          </Text>
          <Icon name="chevron-down" size={14} color={colors.muted} />
        </Pressable>
      )}
    >
      {(close) => (
        <View aria-label={label}>
          {options.map((o) => {
            const selected = o.value === value;
            return (
              <Pressable
                key={o.value}
                role="option"
                aria-selected={selected}
                aria-label={o.accessibilityLabel ?? o.label}
                onPress={() => {
                  onChange(o.value);
                  close();
                }}
                style={(state) => [
                  {
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: space[3],
                    minHeight: isTouch ? touchTarget : 40,
                    paddingHorizontal: space[3],
                    borderRadius: radius.md,
                    backgroundColor: selected ? colors.primarySoft : 'transparent',
                  },
                  (state as { hovered?: boolean }).hovered && !selected
                    ? { backgroundColor: colors.subtle }
                    : null,
                ]}
              >
                <Text variant="body" style={{ flexGrow: 1 }}>
                  {o.label}
                </Text>
                {selected && <Icon name="check" size={16} color={colors.primary} />}
              </Pressable>
            );
          })}
        </View>
      )}
    </Popover>
  );
}
