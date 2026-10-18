import { SupplierBody, SupplierUpdate, type Supplier } from '@orderloop/contracts';
import { FieldGrid, FormDialog, TextField, useToast } from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { validate } from '../errors';
import { useFormState } from '../forms';
import { useApi } from '../runtime';

const blankToNull = (text: string) => (text.trim() === '' ? null : text.trim());

function SupplierForm({ supplier, onClose }: { supplier: Supplier | null; onClose: () => void }) {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const form = useFormState({
    name: supplier?.name ?? '',
    contactName: supplier?.contactName ?? '',
    phone: supplier?.phone ?? '',
    email: supplier?.email ?? '',
    address: supplier?.address ?? '',
    notes: supplier?.notes ?? '',
  });

  async function submit() {
    const v = form.values;
    // Blank optional boxes mean "no value": null clears the field on the server.
    const input = {
      name: v.name,
      contactName: blankToNull(v.contactName),
      phone: blankToNull(v.phone),
      email: blankToNull(v.email),
      address: blankToNull(v.address),
      notes: blankToNull(v.notes),
    };
    const checked = validate(supplier ? SupplierUpdate : SupplierBody, input);
    form.setFormError('');
    if (!checked.data) return form.setErrors(checked.errors ?? {});
    const body = checked.data;
    const ok = await form.run(async () => {
      if (supplier) await api.suppliers.update(supplier.id, body);
      else await api.suppliers.create(body as SupplierBody);
      await queryClient.invalidateQueries({ queryKey: ['suppliers'] });
    });
    if (ok) {
      toast.success(supplier ? 'Supplier saved' : 'Supplier added');
      onClose();
    }
  }

  return (
    <FormDialog
      open
      onClose={onClose}
      title={supplier ? 'Edit supplier' : 'New supplier'}
      onSubmit={submit}
      submitLabel={supplier ? 'Save changes' : 'Add supplier'}
      busy={form.busy}
      error={form.formError}
    >
      <TextField label="Supplier name" required autoFocus {...form.field('name')} />
      <FieldGrid>
        <TextField label="Contact person" {...form.field('contactName')} />
        <TextField label="Phone" keyboardType="phone-pad" {...form.field('phone')} />
        <TextField label="Email" kind="email" {...form.field('email')} />
      </FieldGrid>
      <TextField label="Address" {...form.field('address')} />
      <TextField label="Notes" multiline {...form.field('notes')} />
    </FormDialog>
  );
}

/** Add a supplier or edit one. Set `open` to show it; each opening starts from the supplier's current values. */
export function SupplierDialog({
  supplier,
  open,
  onClose,
}: {
  supplier: Supplier | null;
  open: boolean;
  onClose: () => void;
}) {
  return open ? (
    <SupplierForm key={supplier?.id ?? 'new'} supplier={supplier} onClose={onClose} />
  ) : null;
}
