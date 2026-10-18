import { Button } from '@orderloop/ui';
import { useState } from 'react';
import type { FieldValues } from 'react-hook-form';
import { FormTextField, type FormTextFieldProps } from './FormTextField';

/**
 * A password field with a Show / Hide button at its right edge. The button is named "Show" / "Hide" (not "Show password")
 * so the field is still found by its own label, "Password".
 */
export function FormPasswordField<T extends FieldValues, O extends FieldValues>(
  props: Omit<FormTextFieldProps<T, O>, 'trailing' | 'secureTextEntry'>,
) {
  const [shown, setShown] = useState(false);
  return (
    <FormTextField
      {...props}
      secureTextEntry={!shown}
      trailing={
        <Button variant="tertiary" size="sm" onPress={() => setShown((s) => !s)}>
          {shown ? 'Hide' : 'Show'}
        </Button>
      }
    />
  );
}
