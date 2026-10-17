import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, type FieldValues, type Path, type UseFormReturn } from 'react-hook-form';
import type { z } from 'zod';
import { fieldErrorsFrom, messageFor } from './errors';

export type ZodForm<S extends z.ZodType> = UseFormReturn<
  z.input<S> & FieldValues,
  unknown,
  z.output<S> & FieldValues
> & {
  /** The summary above the form when the server refused the request (field errors sit next to their fields). */
  formError: string;
  /** Wrap what should happen once the values are valid; the result is the form's `onSubmit`. Failures are shown, not thrown. */
  submit: (action: (data: z.output<S>) => Promise<unknown>) => () => void;
};

/**
 * A form (react-hook-form) validated by a zod schema, the same schemas the API uses, so the messages and rules match.
 * Errors show after the first submit and then update as the person types. A failed request is mapped back onto the fields.
 */
export function useZodForm<S extends z.ZodType>(schema: S, defaultValues: z.input<S>): ZodForm<S> {
  const form = useForm<z.input<S> & FieldValues, unknown, z.output<S> & FieldValues>({
    // The resolver is typed against the schema's own input/output; the form's value types are the same shapes.
    resolver: zodResolver(schema as never) as never,
    defaultValues: defaultValues as never,
    mode: 'onSubmit',
    reValidateMode: 'onChange',
  });

  const submit: ZodForm<S>['submit'] = (action) => () => {
    void form.handleSubmit(async (data) => {
      form.clearErrors('root.server');
      try {
        await action(data);
      } catch (error) {
        for (const [path, message] of Object.entries(fieldErrorsFrom(error))) {
          form.setError(path as Path<z.input<S> & FieldValues>, { type: 'server', message });
        }
        form.setError('root.server', { type: 'server', message: messageFor(error) });
      }
    })();
  };

  return Object.assign(form, {
    formError: form.formState.errors.root?.server?.message ?? '',
    submit,
  });
}
