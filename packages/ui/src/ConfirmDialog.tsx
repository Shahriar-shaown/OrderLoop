import type { ReactNode } from 'react';
import { Button } from './Button';
import { Dialog } from './Dialog';

/** "Are you sure?" for a destructive or hard-to-undo action. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={busy} onPress={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
