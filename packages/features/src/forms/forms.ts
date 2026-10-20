import { useCallback, useRef, useState } from 'react';
import type { z } from 'zod';
import { fieldErrorsFrom, messageFor, validate, type FormErrors } from './errors';

/**
 * State for a form of text fields, the same for every screen: values, per-field errors, a form-level error, and a busy
 * flag. `field('email')` returns the props a TextField needs (value, change handler, error), so a screen never repeats
 * that wiring.
 */
/** Letters and digits only, lower-cased: "customerName" and "customer.name" compare equal. */
const squash = (text: string) => text.replace(/[^a-z0-9]/gi, '').toLowerCase();

/**
 * Does an error (keyed by the API's path, such as "address.phone" or "variant.sku") belong to the field `key`? It does when
 * the names match, when the path ends in the field's name, or when the screen lists the path as an alias of the field.
 */
const belongsTo = (errorKey: string, key: string, aliases: readonly string[] = []) =>
  errorKey === key ||
  aliases.includes(errorKey) ||
  squash(errorKey) === squash(key) ||
  errorKey.endsWith(`.${key}`) ||
  errorKey.startsWith(`${key}.`);

export function useFormState<T extends Record<string, string>>(
  initial: T,
  /** For fields whose error path has a different name from the field: `{ phone: ['customer.phone', 'customerId'] }`. */
  aliases: Partial<Record<keyof T & string, readonly string[]>> = {},
) {
  const [values, setValues] = useState<T>(initial);
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  // Editing a field retires its own error (and the summary above the form) straight away; the others stay until they are fixed.
  const aliasesRef = useRef(aliases);
  aliasesRef.current = aliases;
  const set = useCallback((key: keyof T & string, value: string) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => {
      const stale = Object.keys(e).filter((k) => belongsTo(k, key, aliasesRef.current[key]));
      if (!stale.length) return e;
      const next = { ...e };
      for (const k of stale) delete next[k];
      return next;
    });
    setFormError('');
  }, []);

  /** Retire the errors of fields that are not plain text boxes (a picked customer, order lines): by field name or path prefix. */
  const clearFor = useCallback((...keys: string[]) => {
    setErrors((e) => {
      const stale = Object.keys(e).filter((k) => keys.some((key) => belongsTo(k, key)));
      if (!stale.length) return e;
      const next = { ...e };
      for (const k of stale) delete next[k];
      return next;
    });
    setFormError('');
  }, []);

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
  // A ref, not the `busy` state: two Enter presses in the same frame both see the state as "not busy yet".
  const running = useRef(false);
  const run = useCallback(
    async (action: () => Promise<unknown>): Promise<boolean> => {
      if (running.current) return false; // already sending: a second press must not send it again
      running.current = true;
      clear();
      setBusy(true);
      try {
        await action();
        return true;
      } catch (error) {
        fail(error);
        return false;
      } finally {
        running.current = false;
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
    clearFor,
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
