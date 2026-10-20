import { Pressable, View } from 'react-native';
import { Text } from '../Text';
import { useTheme } from '../theme/theme';
import { radius, space, touchTarget } from '../theme/tokens';
import { useT } from '../i18n';
import { useBreakpoint } from '../layout/useBreakpoint';

export interface Segment<T extends string> {
  value: T;
  label: string;
  /** Read by screen readers instead of `label` (a language is announced in its own name). */
  accessibilityLabel?: string;
}

/**
 * A row of mutually exclusive choices drawn as one pill, the chosen one filled: the shape of every "pick one of a few"
 * setting (theme, language). Fills the width it is given, the segments sharing it equally; `label` names the group.
 */
export function SegmentedControl<T extends string>({
  label,
  segments,
  value,
  onChange,
}: {
  label: string;
  segments: readonly Segment<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const { colors } = useTheme();
  const t = useT();
  const { isTouch } = useBreakpoint();
  return (
    <View
      role="radiogroup"
      aria-label={t(label)}
      style={{
        flexDirection: 'row',
        padding: 3,
        gap: 2,
        borderRadius: radius.lg,
        backgroundColor: colors.subtle,
        borderWidth: 1,
        borderColor: colors.border,
      }}
    >
      {segments.map((s) => {
        const selected = s.value === value;
        return (
          <Pressable
            key={s.value}
            role="radio"
            aria-checked={selected}
            aria-label={t(s.accessibilityLabel ?? s.label)}
            onPress={() => onChange(s.value)}
            style={{
              flex: 1,
              minHeight: isTouch ? touchTarget : 32,
              paddingHorizontal: space[3],
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: radius.md,
              backgroundColor: selected ? colors.primary : 'transparent',
            }}
          >
            <Text
              variant="small"
              weight={selected ? 'semibold' : 'medium'}
              numberOfLines={1}
              tone={selected ? 'onPrimary' : 'default'}
            >
              {s.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
