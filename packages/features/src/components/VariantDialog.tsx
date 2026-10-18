import { VariantInput, VariantUpdate, type Variant } from '@orderloop/contracts';
import { FormDialog, useToast } from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { validate, type FormErrors } from '../errors';
import { useFormState } from '../forms';
import { useApi } from '../runtime';
import { emptyVariant, toVariantInput, variantToValues, type VariantValues } from '../variants';
import { VariantFields } from './VariantFields';

function VariantForm({
  productId,
  variant,
  onClose,
}: {
  productId: string;
  variant: Variant | null;
  onClose: () => void;
}) {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const form = useFormState({});
  const [values, setValues] = useState<VariantValues>(() =>
    variant ? variantToValues(variant) : emptyVariant(),
  );
  const editing = variant !== null;

  async function submit() {
    const { value, errors: local } = toVariantInput(values, 'variant');
    // Editing sends no SKU (it never changes); creating validates everything with the API's own schema.
    // The SKU is never sent when editing (it cannot change); creating validates everything with the API's own schema.
    const update: Record<string, unknown> = { ...value };
    delete update.sku;
    const checked = editing ? validate(VariantUpdate, update) : validate(VariantInput, value);
    form.setFormError('');
    const remap = (e: FormErrors) =>
      Object.fromEntries(
        Object.entries(e).map(([k, v]) => [k.startsWith('variant.') ? k : `variant.${k}`, v]),
      );
    if (Object.keys(local).length || !checked.data)
      return form.setErrors({ ...remap(checked.errors ?? {}), ...local });
    const body = checked.data;
    const ok = await form.run(async () => {
      if (variant) await api.products.updateVariant(variant.id, body as VariantUpdate);
      else await api.products.addVariant(productId, body as VariantInput);
      await queryClient.invalidateQueries({ queryKey: ['product'] });
      await queryClient.invalidateQueries({ queryKey: ['products'] });
    });
    if (ok) {
      toast.success(editing ? 'Variant saved' : 'Variant added');
      onClose();
    }
  }

  // Server-side field errors come back as `sku`, `priceMinor`...; show them under the same inputs.
  const errors = Object.fromEntries(
    Object.entries(form.errors).map(([k, v]) => [k.startsWith('variant.') ? k : `variant.${k}`, v]),
  );
  return (
    <FormDialog
      open
      onClose={onClose}
      title={editing ? 'Edit variant' : 'Add variant'}
      icon="tag"
      onSubmit={submit}
      submitLabel={editing ? 'Save changes' : 'Add variant'}
      busy={form.busy}
      error={form.formError}
    >
      <VariantFields
        value={values}
        onChange={setValues}
        errors={errors}
        prefix="variant"
        lockSku={editing}
      />
    </FormDialog>
  );
}

/** Add a variant to a product, or edit one. Set `open` to show it; each opening starts from the variant's current values. */
export function VariantDialog({
  productId,
  variant,
  open,
  onClose,
}: {
  productId: string;
  variant: Variant | null;
  open: boolean;
  onClose: () => void;
}) {
  return open ? (
    <VariantForm
      key={variant?.id ?? 'new'}
      productId={productId}
      variant={variant}
      onClose={onClose}
    />
  ) : null;
}
