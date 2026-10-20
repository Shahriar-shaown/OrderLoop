import { SelectField, type SelectFieldProps } from '@orderloop/ui';
import { Controller, type Control, type FieldValues, type Path } from 'react-hook-form';

type Props<T extends FieldValues, O extends FieldValues> = Omit<
  SelectFieldProps,
  'value' | 'onChange' | 'error'
> & {
  control: Control<T, unknown, O>;
  name: Path<T>;
};

/** A SelectField connected to a react-hook-form field. */
export function FormSelectField<T extends FieldValues, O extends FieldValues>({
  control,
  name,
  ...field
}: Props<T, O>) {
  return (
    <Controller
      control={control as never}
      name={name as never}
      render={({ field: f, fieldState }) => (
        <SelectField
          {...field}
          value={(f.value as string | undefined) ?? ''}
          onChange={f.onChange}
          error={fieldState.error?.message}
        />
      )}
    />
  );
}
