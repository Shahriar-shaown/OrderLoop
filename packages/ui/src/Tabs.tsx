import { Pressable, ScrollView, View } from 'react-native';
import { Text } from './Text';
import { useTheme } from './theme';
import { radius, space, touchTarget } from './tokens';
import { useBreakpoint } from './useBreakpoint';

export interface TabItem {
  value: string;
  label: string;
  /** A count shown in a small pill beside the label (Orders 248). */
  count?: number | undefined;
}

/**
 * A row of tabs (it scrolls sideways when they do not fit). Controlled: the screen keeps `value` and shows the matching panel.
 *  - `underline` (default): page sections (Products, Stock movements, Low stock).
 *  - `segmented`: a short either/or such as the period (Today · 7 days · 30 days).
 *  - `chips`: status filters with counts (All 248, New 9 ...).
 */
export function Tabs({
  items,
  value,
  onChange,
  label,
  variant = 'underline',
}: {
  items: TabItem[];
  value: string;
  onChange: (value: string) => void;
  label: string;
  variant?: 'underline' | 'segmented' | 'chips';
}) {
  const { colors } = useTheme();
  const { isMobile } = useBreakpoint();
  const height = isMobile
    ? touchTarget
    : variant === 'underline'
      ? 44
      : variant === 'chips'
        ? 36
        : 36;
  const tab = (item: TabItem) => {
    const selected = item.value === value;
    const count =
      item.count !== undefined ? (
        <View
          style={{
            borderRadius: radius.full,
            paddingHorizontal: 6,
            minWidth: 22,
            alignItems: 'center',
            backgroundColor: selected && variant !== 'segmented' ? colors.primary : colors.subtle,
          }}
        >
          <Text
            variant="fine"
            numeric
            style={{ color: selected && variant !== 'segmented' ? colors.onPrimary : colors.muted }}
          >
            {item.count}
          </Text>
        </View>
      ) : null;
    const base = {
      minHeight: height,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      gap: space[2],
    };
    const focus = (state: unknown) =>
      (state as { focused?: boolean }).focused
        ? ({
            outlineWidth: 3,
            outlineStyle: 'solid',
            outlineColor: colors.focus,
            outlineOffset: 0,
          } as const)
        : null;
    const style =
      variant === 'underline'
        ? {
            ...base,
            paddingHorizontal: space[4],
            borderBottomWidth: 2,
            borderBottomColor: selected ? colors.primary : 'transparent',
            marginBottom: -1,
          }
        : variant === 'segmented'
          ? {
              ...base,
              paddingHorizontal: space[3],
              borderRadius: radius.md,
              backgroundColor: selected ? colors.surface : 'transparent',
              borderWidth: selected ? 1 : 0,
              borderColor: colors.border,
            }
          : {
              ...base,
              paddingHorizontal: space[3],
              borderRadius: radius.full,
              borderWidth: 1,
              borderColor: selected ? colors.primaryTint : colors.border,
              backgroundColor: selected ? colors.primarySoft : colors.surface,
            };
    return (
      <Pressable
        key={item.value}
        role="tab"
        aria-selected={selected}
        onPress={() => onChange(item.value)}
        style={(state) => [style, focus(state)]}
      >
        <Text
          variant={variant === 'underline' ? 'label' : 'fine'}
          tone={selected ? 'primary' : 'muted'}
          style={variant === 'segmented' && selected ? { color: colors.foreground } : undefined}
        >
          {item.label}
        </Text>
        {count}
      </Pressable>
    );
  };
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ flexGrow: variant === 'segmented' ? 0 : 1 }}
    >
      <View
        role="tablist"
        aria-label={label}
        style={
          variant === 'underline'
            ? {
                flexGrow: 1,
                flexDirection: 'row',
                gap: space[1],
                borderBottomWidth: 1,
                borderBottomColor: colors.border,
              }
            : variant === 'segmented'
              ? {
                  flexDirection: 'row',
                  gap: 2,
                  padding: 3,
                  borderRadius: radius.lg,
                  backgroundColor: colors.subtle,
                }
              : { flexDirection: 'row', gap: space[2], paddingVertical: 2 }
        }
      >
        {items.map(tab)}
      </View>
    </ScrollView>
  );
}
