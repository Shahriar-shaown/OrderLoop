import { useState } from 'react';
import { Pressable, type ViewStyle } from 'react-native';
import { Dialog } from './Dialog';
import { Field } from './Field';
import { Stack } from './Stack';
import { Text } from './Text';
import { useInputStyle } from './TextField';
import { useTheme } from './theme';
import { space } from './tokens';
import type { SelectFieldProps } from './selectTypes';

export type { SelectFieldProps, SelectOption } from './selectTypes';

/** Native implementation: a field that opens a list of choices in a dialog. (SelectField.web.tsx uses the browser's `<select>`.) */
export function SelectField({
  label,
  value,
  onChange,
  options,
  error,
  hint,
  hideLabel,
  required,
  disabled,
}: SelectFieldProps) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const style = useInputStyle({
    state: error ? 'invalid' : 'idle',
    disabled: String(Boolean(disabled)) as 'true',
  });
  const current = options.find((o) => o.value === value);
  return (
    <>
      <Field label={label} error={error} hint={hint} hideLabel={hideLabel} required={required}>
        {(a) => (
          <Pressable
            role="combobox"
            aria-labelledby={a.labelId}
            aria-describedby={a.describedBy}
            aria-expanded={open}
            disabled={disabled}
            onPress={() => setOpen(true)}
            style={[style as ViewStyle, { justifyContent: 'center' }]}
          >
            <Text>{current?.label ?? ''}</Text>
          </Pressable>
        )}
      </Field>
      <Dialog open={open} onClose={() => setOpen(false)} title={label} size="sm">
        <Stack gap={1}>
          {options.map((o) => (
            <Pressable
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              onPress={() => {
                onChange(o.value);
                setOpen(false);
              }}
              style={{
                paddingVertical: space[3],
                paddingHorizontal: space[2],
                backgroundColor: o.value === value ? colors.surface : 'transparent',
              }}
            >
              <Text weight={o.value === value ? 'bold' : 'normal'}>{o.label}</Text>
            </Pressable>
          ))}
        </Stack>
      </Dialog>
    </>
  );
}
