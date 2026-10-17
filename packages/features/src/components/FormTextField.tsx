import { TextField, type TextFieldProps } from '@orderloop/ui';
import { Controller, type Control, type FieldValues, type Path } from 'react-hook-form';

type Props<T extends FieldValues, O extends FieldValues> = Omit<
  TextFieldProps,
  'value' | 'onChangeText' | 'onBlur' | 'error'
> & {
  control: Control<T, unknown, O>;
  name: Path<T>;
};

/** A TextField connected to a react-hook-form field: value, change, blur and the field's error message. */
export function FormTextField<T extends FieldValues, O extends FieldValues>({
  control,
  name,
  ...field
}: Props<T, O>) {
  return (
    <Controller
      control={control as never}
      name={name as never}
      render={({ field: f, fieldState }) => (
        <TextField
          {...field}
          value={(f.value as string | undefined) ?? ''}
          onChangeText={f.onChange}
          onBlur={f.onBlur}
          error={fieldState.error?.message}
        />
      )}
    />
  );
}
