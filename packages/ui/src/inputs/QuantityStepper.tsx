import { Platform, TextInput, View } from 'react-native';
import { toAsciiDigits, useT } from '../i18n';
import { Button } from '../Button';
import { useTheme } from '../theme/theme';
import { fontFamily, fontSize, radius, touchTarget } from '../theme/tokens';
import { useBreakpoint } from '../layout/useBreakpoint';

/**
 * A whole-number box with − and + buttons (order line quantities). The text stays a string so a half-typed value is not
 * rewritten under the cursor; the buttons always produce a whole number from `min` to `max`.
 */
export function QuantityStepper({
  value,
  onChange,
  label,
  min = 1,
  max = 10_000,
}: {
  value: string;
  onChange: (next: string) => void;
  /** Names the box for screen readers: "Quantity (TEE-1)". */
  label: string;
  min?: number;
  max?: number;
}) {
  const { colors } = useTheme();
  const { isTouch } = useBreakpoint();
  const t = useT();
  const n = Number(value);
  const current = Number.isInteger(n) ? n : min;
  const step = (by: number) => onChange(String(Math.min(max, Math.max(min, current + by))));
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: colors.borderStrong,
        borderRadius: radius.md,
        backgroundColor: colors.surface,
      }}
    >
      <Button
        variant="ghost"
        size="sm"
        icon="minus"
        accessibilityLabel={`Decrease ${label}`}
        disabled={current <= min}
        onPress={() => step(-1)}
      />
      <TextInput
        accessibilityLabel={t(label)}
        aria-label={t(label)}
        value={value}
        onChangeText={(t) => onChange(toAsciiDigits(t).replace(/[^0-9]/g, ''))}
        keyboardType="number-pad"
        inputMode="numeric"
        style={[
          {
            width: 44,
            minHeight: isTouch ? touchTarget : 32,
            textAlign: 'center',
            fontSize: fontSize.sm,
            color: colors.foreground,
            fontVariant: ['tabular-nums'],
          },
          Platform.OS === 'web' ? ({ outlineStyle: 'none', fontFamily } as object) : null,
        ]}
      />
      <Button
        variant="ghost"
        size="sm"
        icon="plus"
        accessibilityLabel={`Increase ${label}`}
        disabled={current >= max}
        onPress={() => step(1)}
      />
    </View>
  );
}
