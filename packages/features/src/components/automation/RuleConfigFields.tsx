import { SelectField, Switch, TextField } from '@orderloop/ui';
import { CONFIG_FIELDS, type ConfigField, type RuleDraft } from '../../lib/automation';
import type { AutomationKind } from '@orderloop/contracts';

function Field({
  field,
  value,
  error,
  editable,
  onChange,
}: {
  field: ConfigField;
  value: string | boolean | undefined;
  error: string | undefined;
  editable: boolean;
  onChange: (value: string | boolean) => void;
}) {
  const text = typeof value === 'string' ? value : '';
  switch (field.type) {
    case 'toggle':
      return (
        <Switch
          label={field.label}
          value={value === true}
          disabled={!editable}
          onChange={onChange}
        />
      );
    case 'choice':
      return (
        <SelectField
          label={field.label}
          value={text}
          options={field.options}
          disabled={!editable}
          error={error}
          hint={field.hint}
          onChange={onChange}
        />
      );
    case 'time':
      return (
        <TextField
          label={field.label}
          value={text}
          editable={editable}
          error={error}
          hint={field.hint}
          autoCapitalize="none"
          placeholder="20:00"
          onChangeText={onChange}
        />
      );
    case 'number':
    case 'money':
      return (
        <TextField
          label={field.label}
          kind={field.type === 'money' ? 'decimal' : 'integer'}
          value={text}
          editable={editable}
          error={error}
          hint={field.hint}
          onChangeText={onChange}
        />
      );
  }
}

/** The settings that belong to one kind of rule, drawn from the same description the validation uses. */
export function RuleConfigFields({
  kind,
  draft,
  errors,
  editable,
  onChange,
}: {
  kind: AutomationKind;
  draft: RuleDraft;
  errors: Record<string, string>;
  editable: boolean;
  onChange: (key: string, value: string | boolean) => void;
}) {
  return (
    <>
      {CONFIG_FIELDS[kind]
        .filter((f) => !f.when || f.when(draft))
        .map((f) => (
          <Field
            key={f.key}
            field={f}
            value={draft[f.key]}
            error={errors[f.key]}
            editable={editable}
            onChange={(value) => onChange(f.key, value)}
          />
        ))}
    </>
  );
}
