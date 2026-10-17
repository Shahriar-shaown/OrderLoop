import { useState, type ReactNode } from 'react';
import { Platform, TextInput, View, type TextInputProps } from 'react-native';
import { Field } from './Field';
import { useFormSubmit } from './formContext';
import { useTheme } from './theme';
import { fontSize, radius, space, touchTarget } from './tokens';
import { createTextVariants } from './variants';

export const useInputStyle = createTextVariants((t) => ({
  base: {
    borderWidth: 1,
    borderRadius: radius.md,
    backgroundColor: t.colors.background,
    color: t.colors.foreground,
    fontSize: fontSize.sm,
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    minHeight: touchTarget,
  },
  variants: {
    state: {
      idle: { borderColor: t.colors.border },
      focused: {
        borderColor: t.colors.focus,
        outlineWidth: 2,
        outlineStyle: 'solid',
        outlineColor: t.colors.focus,
        outlineOffset: 0,
      },
      invalid: { borderColor: t.colors.danger },
    },
    multiline: { true: { minHeight: 96, textAlignVertical: 'top' }, false: {} },
    disabled: { true: { opacity: 0.6 }, false: {} },
  },
  defaults: { state: 'idle', multiline: 'false', disabled: 'false' },
}));

/** What the field holds. Sets the right keyboard, autofill hint and capitalisation on every platform in one place. */
const KINDS = {
  text: {},
  email: {
    keyboardType: 'email-address',
    autoComplete: 'email',
    autoCapitalize: 'none',
    autoCorrect: false,
    textContentType: 'emailAddress',
  },
  password: {
    secureTextEntry: true,
    autoComplete: 'current-password',
    autoCapitalize: 'none',
    autoCorrect: false,
    textContentType: 'password',
  },
  newPassword: {
    secureTextEntry: true,
    autoComplete: 'new-password',
    autoCapitalize: 'none',
    autoCorrect: false,
    textContentType: 'newPassword',
  },
  integer: { keyboardType: 'number-pad' },
  signedInteger: { keyboardType: 'numbers-and-punctuation' },
  decimal: { keyboardType: 'decimal-pad' },
  search: { returnKeyType: 'search', autoCapitalize: 'none', autoCorrect: false },
} as const satisfies Record<string, TextInputProps>;

export type TextFieldKind = keyof typeof KINDS;

export interface TextFieldProps extends Omit<
  TextInputProps,
  'style' | 'aria-label' | 'aria-labelledby' | 'aria-describedby' | 'aria-invalid'
> {
  label: string;
  kind?: TextFieldKind;
  error?: string | undefined;
  hint?: string | undefined;
  hideLabel?: boolean | undefined;
  required?: boolean | undefined;
  /** Draws an element inside the field's right edge, for example a show-password toggle. */
  trailing?: ReactNode;
}

/** A labelled text input (`multiline` makes it a text area). Label, hint and error are announced with the input. */
export function TextField({
  label,
  kind = 'text',
  error,
  hint,
  hideLabel,
  required = false,
  trailing,
  editable = true,
  multiline = false,
  onFocus,
  onBlur,
  onSubmitEditing,
  ...rest
}: TextFieldProps) {
  const { colors } = useTheme();
  const submit = useFormSubmit();
  const [focused, setFocused] = useState(false);
  const style = useInputStyle({
    state: error ? 'invalid' : focused ? 'focused' : 'idle',
    multiline: String(multiline) as 'true',
    disabled: String(!editable) as 'true',
  });

  return (
    <Field label={label} error={error} hint={hint} hideLabel={hideLabel} required={required}>
      {(a) => (
        <View>
          <TextInput
            id={a.id}
            aria-labelledby={a.labelId}
            aria-describedby={a.describedBy}
            aria-invalid={a.invalid || undefined}
            aria-required={required || undefined}
            accessibilityLabel={label}
            placeholderTextColor={colors.muted}
            editable={editable}
            multiline={multiline}
            style={[style, trailing ? { paddingRight: space[10] } : null]}
            onFocus={(e) => {
              setFocused(true);
              onFocus?.(e);
            }}
            onBlur={(e) => {
              setFocused(false);
              onBlur?.(e);
            }}
            // On the web the surrounding <form> submits on Enter by itself, but react-native-web cancels that whenever an
            // onSubmitEditing handler is present, so on the web only a handler the caller supplied is passed on.
            {...(Platform.OS === 'web'
              ? onSubmitEditing
                ? { onSubmitEditing }
                : {}
              : {
                  onSubmitEditing: (
                    e: Parameters<NonNullable<TextInputProps['onSubmitEditing']>>[0],
                  ) => {
                    onSubmitEditing?.(e);
                    if (!multiline) submit?.();
                  },
                })}
            {...KINDS[kind]}
            {...rest}
          />
          {trailing && (
            <View
              style={{
                position: 'absolute',
                right: space[2],
                top: 0,
                bottom: 0,
                justifyContent: 'center',
              }}
            >
              {trailing}
            </View>
          )}
        </View>
      )}
    </Field>
  );
}
