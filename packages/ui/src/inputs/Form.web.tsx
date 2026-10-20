import { createElement, useCallback, useMemo } from 'react';
import { FormContext, type FormProps } from './formContext';
import { space } from '../theme/tokens';

/** Web implementation: a real <form>, so Enter submits, password managers work, and assistive tech sees a form landmark. */
export function Form({ onSubmit, children, gap = 4, accessibilityLabel }: FormProps) {
  const submit = useCallback(() => onSubmit(), [onSubmit]);
  const value = useMemo(() => submit, [submit]);
  return (
    <FormContext.Provider value={value}>
      {createElement(
        'form',
        {
          noValidate: true,
          'aria-label': accessibilityLabel,
          style: { display: 'flex', flexDirection: 'column', gap: space[gap] },
          onSubmit: (event: { preventDefault(): void }) => {
            event.preventDefault();
            submit();
          },
        },
        // A hidden submit button is the form's "default button": it is what makes Enter submit a multi-field form.
        children,
        createElement('button', {
          type: 'submit',
          hidden: true,
          tabIndex: -1,
          'aria-hidden': true,
        }),
      )}
    </FormContext.Provider>
  );
}

export { useFormSubmit, type FormProps } from './formContext';
