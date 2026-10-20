import { View } from 'react-native';
import { Text } from '../Text';
import { useTheme } from '../theme/theme';
import { radius, space } from '../theme/tokens';
import { useT } from '../i18n';

export interface Bar {
  key: string;
  /** Short caption under the bar, for example "18". */
  label: string;
  value: number;
}

/**
 * A plain bar chart of real numbers. It draws exactly what it is given: heights are proportional to `value`, a zero is an
 * empty slot, and nothing is smoothed or invented. Screen readers get one sentence (`summary`) instead of a pile of
 * rectangles; always say the numbers in it.
 */
export function BarChart({
  bars,
  summary,
  height = 120,
}: {
  bars: Bar[];
  summary: string;
  height?: number;
}) {
  const { colors } = useTheme();
  const t = useT();
  const max = Math.max(0, ...bars.map((b) => b.value));
  // With many bars, caption only the first, the last and every few in between so captions never collide.
  const every = bars.length > 10 ? Math.ceil(bars.length / 6) : 1;
  return (
    <View role="img" aria-label={t(summary)} style={{ width: '100%' }}>
      <View
        aria-hidden
        style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space[1], height, minWidth: 0 }}
      >
        {bars.map((b) => (
          <View
            key={b.key}
            style={{ flex: 1, minWidth: 0, justifyContent: 'flex-end', height: '100%' }}
          >
            <View
              style={{
                height: max === 0 ? 2 : Math.max(2, Math.round((b.value / max) * (height - 4))),
                backgroundColor: b.value === 0 ? colors.border : colors.primary,
                borderTopLeftRadius: radius.sm,
                borderTopRightRadius: radius.sm,
              }}
            />
          </View>
        ))}
      </View>
      <View aria-hidden style={{ flexDirection: 'row', gap: space[1], marginTop: space[1] }}>
        {bars.map((b, i) => (
          <View key={b.key} style={{ flex: 1, minWidth: 0, alignItems: 'center' }}>
            <Text variant="caption" tone="muted" numberOfLines={1}>
              {i % every === 0 || i === bars.length - 1 ? b.label : ''}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}
