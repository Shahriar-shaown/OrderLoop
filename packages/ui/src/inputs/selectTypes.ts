export interface SelectOption {
  value: string;
  label: string;
}

/** Shared by SelectField (native) and SelectField.web. */
export interface SelectFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  error?: string | undefined;
  hint?: string | undefined;
  hideLabel?: boolean | undefined;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
}
