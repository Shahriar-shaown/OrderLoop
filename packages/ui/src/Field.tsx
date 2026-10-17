import { useId, type ReactNode } from 'react';
import { View } from 'react-native';
import { Text } from './Text';
import { space } from './tokens';

/** What an input needs to be announced together with its label, hint and error. */
export interface FieldA11y {
  id: string;
  labelId: string;
  /** Space-separated ids of the hint / error text, for `aria-describedby`. */
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
}

export interface FieldProps {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
  /** Keep the label for screen readers but do not draw it (a search box with a placeholder). */
  hideLabel?: boolean | undefined;
  required?: boolean | undefined;
  children: (a11y: FieldA11y) => ReactNode;
}

const HIDDEN = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  opacity: 0,
} as const;

/**
 * The label + hint + error frame around any input (TextField, SelectField, ...), so every input announces itself the
 * same way and looks the same. The input itself comes from the render prop, which receives the ids to wire up.
 */
export function Field({
  label,
  error,
  hint,
  hideLabel = false,
  required = false,
  children,
}: FieldProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const describedBy =
    [hint && !error ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') ||
    undefined;
  return (
    <View>
      <Text
        nativeID={labelId}
        variant="label"
        style={hideLabel ? HIDDEN : { marginBottom: space[1] }}
      >
        {label}
        {required ? ' *' : ''}
      </Text>
      {children({ id, labelId, describedBy, invalid: Boolean(error), required })}
      {hint && !error && (
        <Text
          nativeID={`${id}-hint`}
          variant="caption"
          tone="muted"
          style={{ marginTop: space[1] }}
        >
          {hint}
        </Text>
      )}
      {error && (
        <Text
          nativeID={`${id}-error`}
          role="alert"
          variant="caption"
          tone="danger"
          weight="medium"
          style={{ marginTop: space[1] }}
        >
          {error}
        </Text>
      )}
    </View>
  );
}
