import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { mount } from '../../test/mount';
import { hasReason, ReasonDialog, REASON_ERROR } from './ReasonDialog';

const dialog = (open: boolean, onSubmit = vi.fn(async () => undefined)) => (
  <ReasonDialog open={open} title="Why?" onSubmit={onSubmit} onClose={() => undefined} />
);

describe('ReasonDialog', () => {
  it('needs at least 3 characters before it calls anything', async () => {
    const onSubmit = vi.fn(async () => undefined);
    mount(dialog(true, onSubmit), {});
    await userEvent.type(screen.getByLabelText(/Reason/), ' a ');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText(REASON_ERROR)).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(hasReason('  ab ')).toBe(false);
    expect(hasReason('abc')).toBe(true);
  });

  it('lets an optional reason be empty, or any length', async () => {
    const onSubmit = vi.fn(async () => undefined);
    mount(<ReasonDialog optional title="Why?" onSubmit={onSubmit} onClose={() => undefined} />, {});
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onSubmit).toHaveBeenLastCalledWith('');
    await userEvent.type(screen.getByLabelText(/Reason/), 'no');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onSubmit).toHaveBeenLastCalledWith('no');
  });

  it('starts empty each time it opens', async () => {
    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button onClick={() => setOpen((o) => !o)}>toggle</button>
          {dialog(open)}
        </>
      );
    }
    mount(<Host />, {});
    await userEvent.type(screen.getByLabelText(/Reason/), 'Courier strike');
    await userEvent.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.queryByLabelText(/Reason/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'toggle' }));
    expect((screen.getByLabelText(/Reason/) as HTMLInputElement).value).toBe('');
  });
});
