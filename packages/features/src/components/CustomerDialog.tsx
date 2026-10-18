import { CustomerBody, CustomerUpdate, type CustomerDetail } from '@orderloop/contracts';
import { formatBdPhone } from '@orderloop/domain';
import { FieldGrid, FormDialog, TextField, useToast } from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { validate } from '../errors';
import { useFormState } from '../forms';
import { invalidateOrders } from '../orders';
import { useApi } from '../runtime';

const blank = (t: string) => (t.trim() === '' ? null : t.trim());

function CustomerForm({
  customer,
  onClose,
  onSaved,
}: {
  customer: CustomerDetail | null;
  onClose: () => void;
  onSaved?: (c: CustomerDetail) => void;
}) {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const form = useFormState({
    name: customer?.name ?? '',
    phone: customer ? formatBdPhone(customer.phone) : '',
    email: customer?.email ?? '',
    notes: customer?.notes ?? '',
  });
  async function submit() {
    const v = form.values;
    const input = { name: v.name, phone: v.phone, email: blank(v.email), notes: blank(v.notes) };
    const checked = validate(customer ? CustomerUpdate : CustomerBody, input);
    form.setFormError('');
    if (!checked.data) return form.setErrors(checked.errors ?? {});
    const body = checked.data;
    let saved: CustomerDetail | null = null;
    const ok = await form.run(async () => {
      saved = customer
        ? await api.customers.update(customer.id, body)
        : await api.customers.create(body as CustomerBody);
      await invalidateOrders(queryClient);
    });
    if (ok && saved) {
      toast.success(customer ? 'Customer saved' : 'Customer added');
      onSaved?.(saved);
      onClose();
    }
  }
  return (
    <FormDialog
      open
      onClose={onClose}
      title={customer ? 'Edit customer' : 'New customer'}
      onSubmit={submit}
      submitLabel={customer ? 'Save changes' : 'Add customer'}
      busy={form.busy}
      error={form.formError}
    >
      <FieldGrid>
        <TextField label="Name" required autoFocus {...form.field('name')} />
        <TextField
          label="Phone"
          required
          keyboardType="phone-pad"
          placeholder="01712-345678"
          {...form.field('phone')}
        />
      </FieldGrid>
      <TextField label="Email" kind="email" {...form.field('email')} />
      <TextField label="Notes" multiline {...form.field('notes')} />
    </FormDialog>
  );
}

export function CustomerDialog({
  customer,
  open,
  onClose,
  onSaved,
}: {
  customer: CustomerDetail | null;
  open: boolean;
  onClose: () => void;
  onSaved?: (c: CustomerDetail) => void;
}) {
  return open ? (
    <CustomerForm
      key={customer?.id ?? 'new'}
      customer={customer}
      onClose={onClose}
      {...(onSaved ? { onSaved } : {})}
    />
  ) : null;
}
