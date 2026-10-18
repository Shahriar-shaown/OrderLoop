import { Pressable, View } from 'react-native';
import { Icon } from './Icon';
import { Popover } from './Popover';
import { Text } from './Text';
import { useTheme } from './theme';
import { radius, space } from './tokens';
import { useBreakpoint } from './useBreakpoint';

export interface FilterOption {
  value: string;
  label: string;
}

/**
 * A filter chip that opens a short list: "Payment ▾". `value` '' means no filter (the first option, usually "All"). When a
 * value is chosen the chip shows it ("Courier: Pathao") and is tinted.
 */
export function FilterMenu({
  label,
  value,
  options,
  onChange,
  allLabel = 'All',
}: {
  label: string;
  value: string;
  options: FilterOption[];
  onChange: (value: string) => void;
  allLabel?: string;
}) {
  const { colors } = useTheme();
  const { isMobile } = useBreakpoint();
  const chosen = options.find((o) => o.value === value);
  const active = value !== '';
  return (
    <Popover
      haspopup="listbox"
      width={240}
      trigger={(p) => (
        <Pressable
          role="button"
          aria-haspopup="listbox"
          aria-expanded={p['aria-expanded']}
          onPress={p.onPress}
          style={(state) => [
            {
              flexDirection: 'row',
              alignItems: 'center',
              gap: space[2],
              minHeight: isMobile ? 44 : 36,
              paddingHorizontal: space[3],
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: active ? colors.primaryTint : colors.borderStrong,
              backgroundColor: active ? colors.primarySoft : colors.surface,
            },
            (state as { hovered?: boolean }).hovered
              ? { backgroundColor: active ? colors.primaryTint : colors.subtle }
              : null,
            (state as { focused?: boolean }).focused
              ? ({ outlineWidth: 3, outlineStyle: 'solid', outlineColor: colors.focus } as object)
              : null,
          ]}
        >
          <Text
            variant="fine"
            style={{ color: active ? colors.tones.brand.text : colors.foreground }}
          >
            {`${label}: ${chosen ? chosen.label : allLabel}`}
          </Text>
          <Icon name="chevron-down" size={14} color={colors.muted} />
        </Pressable>
      )}
    >
      {(close) => (
        <View>
          {[{ value: '', label: allLabel }, ...options].map((o) => {
            const selected = o.value === value;
            return (
              <Pressable
                key={o.value || 'all'}
                role="option"
                aria-selected={selected}
                onPress={() => {
                  onChange(o.value);
                  close();
                }}
                style={(state) => [
                  {
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: space[3],
                    minHeight: 40,
                    paddingHorizontal: space[3],
                    borderRadius: radius.md,
                    backgroundColor: selected ? colors.primarySoft : 'transparent',
                  },
                  (state as { hovered?: boolean }).hovered && !selected
                    ? { backgroundColor: colors.subtle }
                    : null,
                ]}
              >
                <View style={{ width: 16 }}>
                  {selected && <Icon name="check" size={16} color={colors.primary} />}
                </View>
                <Text style={{ flexShrink: 1 }}>{o.label}</Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </Popover>
  );
}
