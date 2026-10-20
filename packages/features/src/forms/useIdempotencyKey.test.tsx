import { ApiError } from '@orderloop/api-client';
import { act, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { mount } from '../../test/mount';
import { NameDialog } from './NameDialog';
import { useIdempotencyKey } from './useIdempotencyKey';

describe('useIdempotencyKey', () => {
  it('keeps one valid key across renders, and a different one for each mount', () => {
    const a = renderHook(() => useIdempotencyKey());
    const first = a.result.current.key;
    expect(first).toMatch(/^app-[A-Za-z0-9._:-]{8,}$/);
    a.rerender();
    expect(a.result.current.key).toBe(first);
    const b = renderHook(() => useIdempotencyKey());
    expect(b.result.current.key).not.toBe(first);
  });

  it('makes a new key only when asked to', () => {
    const { result } = renderHook(() => useIdempotencyKey());
    const first = result.current.key;
    act(() => result.current.renew());
    expect(result.current.key).not.toBe(first);
  });
});

describe('a create dialog that fails and is retried', () => {
  function Host({ onSubmit }: { onSubmit: (name: string, key: string) => Promise<unknown> }) {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button onClick={() => setOpen((o) => !o)}>toggle</button>
        <NameDialog
          open={open}
          title="New thing"
          label="Name"
          initial=""
          submitLabel="Create"
          success="Created"
          onSubmit={onSubmit}
          onClose={() => setOpen(false)}
        />
      </>
    );
  }

  it('sends the same key on the retry, and a new one when it is opened again', async () => {
    const onSubmit = vi
      .fn<(name: string, key: string) => Promise<unknown>>()
      .mockRejectedValueOnce(new ApiError('timed out', undefined, 'request_timeout'))
      .mockResolvedValue({});
    mount(<Host onSubmit={onSubmit} />, {});
    await userEvent.type(screen.getByLabelText(/Name/), 'Shoes');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    await userEvent.click(await screen.findByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    const [first, second] = onSubmit.mock.calls;
    expect(second![1]).toBe(first![1]);

    // It closed after the success; opening it again is a new request.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: 'toggle' }));
    await userEvent.type(await screen.findByLabelText(/Name/), 'Bags');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(3));
    expect(onSubmit.mock.calls[2]![1]).not.toBe(first![1]);
  });
});
