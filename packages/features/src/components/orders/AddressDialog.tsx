import { AddressBody, type AddressRecord } from '@orderloop/contracts';
import { formatBdPhone } from '@orderloop/domain';
import { FieldGrid, FormDialog, SelectField, TextField, useToast } from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { validate } from '../../forms/errors';
import { useFormState } from '../../forms/forms';
import { DIVISION_OPTIONS, invalidateOrders } from '../../lib/orders';
import { useApi } from '../../core/runtime';

function AddressForm({
  customerId,
  address,
  defaults,
  onClose,
}: {
  customerId: string;
  address: AddressRecord | null;
  defaults: { name: string; phone: string };
  onClose: () => void;
}) {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const form = useFormState({
    label: address?.label ?? '',
    recipientName: address?.recipientName ?? defaults.name,
    phone: formatBdPhone(address?.phone ?? defaults.phone),
    line1: address?.line1 ?? '',
    area: address?.area ?? '',
    district: address?.district ?? '',
    division: address?.division ?? 'Dhaka',
    postalCode: address?.postalCode ?? '',
  });
  async function submit() {
    const v = form.values;
    const input = {
      label: v.label.trim() || null,
      recipientName: v.recipientName,
      phone: v.phone,
      line1: v.line1,
      area: v.area,
      district: v.district,
      division: v.division,
      postalCode: v.postalCode.trim() || null,
    };
    const checked = validate(AddressBody, input);
    form.setFormError('');
    if (!checked.data) return form.setErrors(checked.errors ?? {});
    const body = checked.data;
    const ok = await form.run(async () => {
      if (address) await api.customers.updateAddress(customerId, address.id, body);
      else await api.customers.addAddress(customerId, body);
      await invalidateOrders(queryClient);
    });
    if (ok) {
      toast.success(address ? 'Address saved' : 'Address added');
      onClose();
    }
  }
  return (
    <FormDialog
      open
      onClose={onClose}
      title={address ? 'Edit address' : 'New address'}
      onSubmit={submit}
      submitLabel={address ? 'Save changes' : 'Add address'}
      busy={form.busy}
      error={form.formError}
    >
      <TextField label="Label" placeholder="Home, office…" {...form.field('label')} />
      <FieldGrid>
        <TextField label="Recipient name" required {...form.field('recipientName')} />
        <TextField
          label="Recipient phone"
          required
          keyboardType="phone-pad"
          {...form.field('phone')}
        />
      </FieldGrid>
      <TextField
        label="Address"
        required
        placeholder="House, road, village"
        {...form.field('line1')}
      />
      <FieldGrid>
        <TextField label="Thana / upazila" required {...form.field('area')} />
        <TextField label="District" required {...form.field('district')} />
        <SelectField
          label="Division"
          options={DIVISION_OPTIONS}
          value={form.values.division}
          onChange={(x) => form.set('division', x)}
          error={form.errors.division}
        />
        <TextField label="Postal code" keyboardType="number-pad" {...form.field('postalCode')} />
      </FieldGrid>
    </FormDialog>
  );
}

export function AddressDialog({
  customerId,
  address,
  defaults,
  open,
  onClose,
}: {
  customerId: string;
  address: AddressRecord | null;
  defaults: { name: string; phone: string };
  open: boolean;
  onClose: () => void;
}) {
  return open ? (
    <AddressForm
      key={address?.id ?? 'new'}
      customerId={customerId}
      address={address}
      defaults={defaults}
      onClose={onClose}
    />
  ) : null;
}
