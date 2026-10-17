import { useCallback, useState } from 'react';
import type { z } from 'zod';
import { fieldErrorsFrom, messageFor, validate, type FormErrors } from './errors';

/**
 * State for a form of text fields, the same for every screen: values, per-field errors, a form-level error, and a busy
 * flag. `field('email')` returns the props a TextField needs (value, change handler, error), so a screen never repeats
 * that wiring.
 */
export function useFormState<T extends Record<string, string>>(initial: T) {
  const [values, setValues] = useState<T>(initial);
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = useCallback(
    (key: keyof T & string, value: string) => setValues((v) => ({ ...v, [key]: value })),
    [],
  );

  const clear = useCallback(() => {
    setErrors({});
    setFormError('');
  }, []);

  /** Show a failed request: its field errors next to the fields, and a summary above the form. */
  const fail = useCallback((error: unknown) => {
    setErrors(fieldErrorsFrom(error));
    setFormError(messageFor(error));
  }, []);

  /** Check values against a contracts schema (the same rules the API applies). Returns the parsed data, or null after marking the fields. */
  const check = useCallback(
    <S extends z.ZodType>(schema: S, input: unknown): z.output<S> | null => {
      const result = validate(schema, input);
      setFormError('');
      setErrors(result.errors ?? {});
      return result.data;
    },
    [],
  );

  /** Run a request with the busy flag on and failures shown; resolves to whether it succeeded. */
  const run = useCallback(
    async (action: () => Promise<unknown>): Promise<boolean> => {
      clear();
      setBusy(true);
      try {
        await action();
        return true;
      } catch (error) {
        fail(error);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [clear, fail],
  );

  return {
    values,
    errors,
    formError,
    busy,
    set,
    setErrors,
    setFormError,
    clear,
    fail,
    check,
    run,
    field: (key: keyof T & string) => ({
      value: values[key],
      onChangeText: (text: string) => set(key, text),
      error: errors[key],
    }),
  };
}

export type FormState<T extends Record<string, string>> = ReturnType<typeof useFormState<T>>;
