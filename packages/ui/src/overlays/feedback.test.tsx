import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderUi } from '../../test/render';
import { Alert } from '../feedback/Alert';
import { Badge } from '../feedback/Badge';
import { ConfirmDialog } from './ConfirmDialog';
import { DataTable } from '../data/DataTable';
import { Dialog } from './Dialog';
import { EmptyState } from '../feedback/EmptyState';
import { FormDialog } from './FormDialog';
import { TextField } from '../inputs/TextField';
import { useToast } from './Toast';

describe('Alert', () => {
  it('announces errors immediately and other tones politely', () => {
    renderUi(
      <>
        <Alert tone="error">Broke</Alert>
        <Alert tone="success">Fine</Alert>
      </>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Broke');
    expect(screen.getByRole('status')).toHaveTextContent('Fine');
  });
});

describe('Badge and EmptyState', () => {
  it('say their text (colour is never the only signal)', () => {
    renderUi(
      <>
        <Badge tone="warning">Low</Badge>
        <EmptyState title="Nothing yet">Add something.</EmptyState>
      </>,
    );
    expect(screen.getByText('Low')).toBeInTheDocument();
    expect(screen.getByText('Nothing yet')).toBeInTheDocument();
    expect(screen.getByText('Add something.')).toBeInTheDocument();
  });
});

describe('DataTable', () => {
  it('exposes table semantics and renders each column for each row', () => {
    renderUi(
      <DataTable
        label="People"
        rowKey={(r) => r.id}
        rows={[
          { id: '1', name: 'Rina', age: 30 },
          { id: '2', name: 'Anwar', age: 41 },
        ]}
        columns={[
          { key: 'name', header: 'Name', render: (r) => r.name },
          { key: 'age', header: 'Age', align: 'right', render: (r) => String(r.age) },
        ]}
      />,
    );
    expect(screen.getByRole('table', { name: 'People' })).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Name', 'Age']);
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.getByRole('row', { name: /Anwar/ })).toHaveTextContent('41');
  });
});

describe('Dialog (web)', () => {
  beforeAll(() => {
    // jsdom has no modal <dialog> behaviour; this stands in for the browser's.
    const proto = HTMLDialogElement.prototype as unknown as { showModal(): void; close(): void };
    proto.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    proto.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  });
  afterEach(() => {
    document.body.style.overflow = '';
  });

  it('opens as a labelled modal dialog and shows its content only while open', () => {
    const { rerender } = renderUi(
      <Dialog open onClose={() => undefined} title="Receive stock">
        Body text
      </Dialog>,
    );
    expect(screen.getByRole('dialog', { name: 'Receive stock' })).toBeInTheDocument();
    expect(screen.getByText('Body text')).toBeInTheDocument();
    expect(document.body.style.overflow).toBe('hidden');
    rerender(
      <Dialog open={false} onClose={() => undefined} title="Receive stock">
        Body text
      </Dialog>,
    );
    expect(screen.queryByText('Body text')).not.toBeInTheDocument();
  });

  it('asks to close on Escape (the browser cancel event) and on a backdrop click', () => {
    const onClose = vi.fn();
    renderUi(
      <Dialog open onClose={onClose} title="T">
        x
      </Dialog>,
    );
    const dialog = document.querySelector('dialog')!;
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(dialog); // the dialog element itself is the backdrop area
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByText('x'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('puts the cursor in the first text field', () => {
    renderUi(
      <Dialog open onClose={() => undefined} title="T">
        <TextField label="Quantity" />
      </Dialog>,
    );
    expect(screen.getByLabelText('Quantity')).toHaveFocus();
  });

  it('ConfirmDialog confirms or cancels', async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    renderUi(
      <ConfirmDialog
        open
        title="Delete?"
        confirmLabel="Delete"
        danger
        onConfirm={onConfirm}
        onClose={onClose}
      >
        Sure?
      </ConfirmDialog>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('FormDialog submits with Enter from inside the dialog and shows its error', async () => {
    const onSubmit = vi.fn();
    renderUi(
      <FormDialog
        open
        onClose={() => undefined}
        title="Name it"
        onSubmit={onSubmit}
        submitLabel="Save"
        error="Name taken"
      >
        <TextField label="Name" />
      </FormDialog>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Name taken');
    await userEvent.type(screen.getByLabelText('Name'), 'x{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe('Toast', () => {
  function Demo() {
    const toast = useToast();
    return (
      <>
        <button onClick={() => toast.success('Saved')}>ok</button>
        <button onClick={() => toast.error('Failed')}>bad</button>
      </>
    );
  }

  it('shows a polite message for success and an assertive one for errors, and dismisses them', async () => {
    renderUi(<Demo />);
    await userEvent.click(screen.getByText('ok'));
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
    await userEvent.click(screen.getByText('bad'));
    expect(screen.getByRole('alert')).toHaveTextContent('Failed');
    await userEvent.click(screen.getAllByRole('button', { name: 'Dismiss message' })[0]!);
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('removes a message by itself after a few seconds', () => {
    vi.useFakeTimers();
    try {
      renderUi(<Demo />);
      fireEvent.click(screen.getByText('ok'));
      expect(screen.getByText('Saved')).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(5100);
      });
      expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
