import { useCallback, useMemo } from 'react';
import { View } from 'react-native';
import { FormContext, type FormProps } from './formContext';
import { space } from '../theme/tokens';

/**
 * Native implementation. A <Form> groups fields and a submit button: pressing the submit Button, or the keyboard's
 * "done" key in a field, calls `onSubmit`. (Form.web.tsx renders a real <form>, so browsers offer password managers and
 * autofill and Enter submits natively.)
 */
export function Form({ onSubmit, children, gap = 4, accessibilityLabel }: FormProps) {
  const submit = useCallback(() => onSubmit(), [onSubmit]);
  const value = useMemo(() => submit, [submit]);
  return (
    <FormContext.Provider value={value}>
      <View role="form" aria-label={accessibilityLabel} style={{ gap: space[gap] }}>
        {children}
      </View>
    </FormContext.Provider>
  );
}

export { useFormSubmit, type FormProps } from './formContext';
