import { Pressable, View } from 'react-native';
import { Text } from './Text';
import { useTheme } from './theme';
import { space, touchTarget } from './tokens';

export interface RadioOption {
  value: string;
  label: string;
  hint?: string;
}

/** A single-choice group drawn as radio buttons. */
export function RadioGroup({
  label,
  value,
  onChange,
  options,
  direction = 'row',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: RadioOption[];
  direction?: 'row' | 'column';
}) {
  const { colors } = useTheme();
  return (
    <View
      role="radiogroup"
      aria-label={label}
      style={{
        flexDirection: direction,
        flexWrap: 'wrap',
        gap: direction === 'row' ? space[5] : space[2],
      }}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            role="radio"
            aria-checked={on}
            onPress={() => onChange(o.value)}
            style={(state) => [
              { flexDirection: 'row', alignItems: 'center', gap: space[2], minHeight: touchTarget },
              (state as { focused?: boolean }).focused
                ? ({
                    outlineWidth: 3,
                    outlineStyle: 'solid',
                    outlineColor: colors.focus,
                    borderRadius: 8,
                  } as object)
                : null,
            ]}
          >
            <View
              style={{
                width: 18,
                height: 18,
                borderRadius: 9,
                borderWidth: on ? 5 : 1.5,
                borderColor: on ? colors.primary : colors.borderStrong,
                backgroundColor: colors.surface,
              }}
            />
            <View>
              <Text>{o.label}</Text>
              {o.hint ? (
                <Text variant="caption" tone="muted">
                  {o.hint}
                </Text>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/** An on/off switch with a visible label. */
export function Switch({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      role="switch"
      aria-checked={value}
      aria-label={label}
      disabled={disabled}
      onPress={() => onChange(!value)}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[3],
        minHeight: touchTarget,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <View
        style={{
          width: 40,
          height: 22,
          borderRadius: 11,
          backgroundColor: value ? colors.primary : colors.borderStrong,
          padding: 2,
          justifyContent: 'center',
        }}
      >
        <View
          style={{
            width: 18,
            height: 18,
            borderRadius: 9,
            backgroundColor: '#fff',
            alignSelf: value ? 'flex-end' : 'flex-start',
          }}
        />
      </View>
      <Text>{label}</Text>
    </Pressable>
  );
}
