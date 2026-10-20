import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderUi } from '../../test/render';
import { Button } from '../Button';
import { Field } from './Field';
import { Form } from './Form';
import { SelectField } from './SelectField';
import { TextField } from './TextField';

function Login({ onSubmit }: { onSubmit: () => void }) {
  const [email, setEmail] = useState('');
  return (
    <Form onSubmit={onSubmit} accessibilityLabel="Sign in">
      <TextField label="Email" kind="email" required value={email} onChangeText={setEmail} />
      <TextField label="Password" kind="password" />
      <Button type="submit">Go</Button>
    </Form>
  );
}

describe('TextField', () => {
  it('connects its label, hint and error to the input for assistive technology', () => {
    renderUi(
      <TextField
        label="Email"
        hint="We never share it."
        error="Not an email"
        value=""
        onChangeText={() => undefined}
      />,
    );
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const described = input.getAttribute('aria-describedby') ?? '';
    // With an error showing, the error (not the hint) describes the field.
    expect(document.getElementById(described)).toHaveTextContent('Not an email');
    expect(screen.getByRole('alert')).toHaveTextContent('Not an email');
    expect(screen.queryByText('We never share it.')).not.toBeInTheDocument();
  });

  it('marks required fields in the label and for screen readers', () => {
    renderUi(<TextField label="Email" required value="" onChangeText={() => undefined} />);
    expect(screen.getByLabelText(/Email/)).toHaveAttribute('aria-required', 'true');
    expect(screen.getByText('Email *')).toBeInTheDocument();
  });

  it('sets the right input type and autofill hint for its kind', () => {
    renderUi(
      <>
        <TextField label="Email" kind="email" />
        <TextField label="Password" kind="password" />
        <TextField label="New password" kind="newPassword" />
      </>,
    );
    expect(screen.getByLabelText('Email')).toHaveAttribute('type', 'email');
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByLabelText('New password')).toHaveAttribute('autocomplete', 'new-password');
  });

  it('can hide its label visually while keeping it for screen readers', () => {
    renderUi(<TextField label="Search" hideLabel value="" onChangeText={() => undefined} />);
    expect(screen.getByLabelText('Search')).toBeInTheDocument();
  });
});

describe('Form', () => {
  it('submits once when the button is pressed', async () => {
    const onSubmit = vi.fn();
    renderUi(<Login onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });

  it('submits once when Enter is pressed in a field (a real form, so no handler may cancel it)', async () => {
    const onSubmit = vi.fn();
    renderUi(<Login onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText(/Email/), 'a@b.c{Enter}');
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });

  it('renders as a labelled form landmark', () => {
    renderUi(<Login onSubmit={() => undefined} />);
    expect(screen.getByRole('form', { name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('Field', () => {
  it('gives the input the ids it needs', () => {
    renderUi(<Field label="Name">{(a) => <input id={a.id} aria-labelledby={a.labelId} />}</Field>);
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
  });
});

describe('SelectField (web)', () => {
  it('is a native select that reports the chosen value', () => {
    const onChange = vi.fn();
    renderUi(
      <SelectField
        label="Status"
        value="A"
        onChange={onChange}
        options={[
          { value: 'A', label: 'Active' },
          { value: 'B', label: 'Archived' },
        ]}
      />,
    );
    const select = screen.getByLabelText('Status');
    expect(select.tagName).toBe('SELECT');
    expect(select).toHaveValue('A');
    fireEvent.change(select, { target: { value: 'B' } });
    expect(onChange).toHaveBeenCalledWith('B');
  });
});
