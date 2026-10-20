import { createElement, useState } from 'react';
import { Field } from './Field';
import { useInputStyle } from './TextField';
import { fontSize } from '../theme/tokens';
import type { SelectFieldProps } from './selectTypes';

export type { SelectFieldProps, SelectOption } from './selectTypes';

/** Web implementation: the browser's own `<select>`, which is the most accessible dropdown there is. */
export function SelectField({
  label,
  value,
  onChange,
  options,
  error,
  hint,
  hideLabel,
  required,
  disabled,
}: SelectFieldProps) {
  const [focused, setFocused] = useState(false);
  const base = useInputStyle({
    state: error ? 'invalid' : focused ? 'focused' : 'idle',
    disabled: String(Boolean(disabled)) as 'true',
  }) as object;
  return (
    <Field label={label} error={error} hint={hint} hideLabel={hideLabel} required={required}>
      {(a) =>
        createElement(
          'select',
          {
            id: a.id,
            value,
            disabled,
            'aria-labelledby': a.labelId,
            'aria-describedby': a.describedBy,
            'aria-invalid': a.invalid || undefined,
            'aria-required': required || undefined,
            onChange: (event: { target: { value: string } }) => onChange(event.target.value),
            onFocus: () => setFocused(true),
            onBlur: () => setFocused(false),
            // React Native styles do not apply to a DOM element, so the same tokens are written as CSS here.
            style: {
              ...flatten(base),
              width: '100%',
              fontSize: fontSize.sm,
              boxSizing: 'border-box',
            },
          },
          options.map((o) => createElement('option', { key: o.value, value: o.value }, o.label)),
        )
      }
    </Field>
  );
}

/** Flatten RN style arrays into one object and turn the RN-only keys into CSS. */
function flatten(style: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (s: unknown) => {
    if (Array.isArray(s)) s.forEach(walk);
    else if (s && typeof s === 'object') Object.assign(out, s);
  };
  walk(style);
  const css: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(out)) {
    if (k === 'borderWidth') css.borderWidth = v;
    else if (
      k === 'outlineWidth' ||
      k === 'outlineStyle' ||
      k === 'outlineColor' ||
      k === 'outlineOffset'
    )
      css[k] = v;
    else if (k === 'paddingHorizontal') {
      css.paddingLeft = v;
      css.paddingRight = v;
    } else if (k === 'paddingVertical') {
      css.paddingTop = v;
      css.paddingBottom = v;
    } else if (k === 'textAlignVertical') continue;
    else css[k] = v;
  }
  css.borderStyle = 'solid';
  return css;
}
