import { UNITS } from '@orderloop/contracts';
import { FieldGrid, SelectField, TextField } from '@orderloop/ui';
import { useMemo } from 'react';
import { useCategories, useSuppliers } from '../../lib/hooks';
import type { FormState } from '../../forms/forms';

export type ProductDetailValues = {
  name: string;
  description: string;
  categoryId: string;
  supplierId: string;
  /** One link per line. */
  imageUrls: string;
  unit: string;
};

/** The picture links typed one per line, without blanks. */
export const parseImageLinks = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

/** Name, description, category and unit: shared by "new product" and "edit product". */
export function ProductDetailsFields({ form }: { form: FormState<ProductDetailValues> }) {
  const categories = useCategories();
  const categoryOptions = useMemo(
    () => [
      { value: '', label: 'No category' },
      ...(categories.data ?? []).map((c) => ({ value: c.id, label: c.name })),
    ],
    [categories.data],
  );
  const suppliers = useSuppliers();
  const supplierOptions = useMemo(
    () => [
      { value: '', label: 'No supplier' },
      ...(suppliers.data ?? [])
        .filter((s) => !s.archived)
        .map((s) => ({ value: s.id, label: s.name })),
    ],
    [suppliers.data],
  );
  const unitOptions = useMemo(() => UNITS.map((u) => ({ value: u, label: u })), []);
  return (
    <>
      <TextField label="Product name" required {...form.field('name')} />
      <TextField label="Description" multiline {...form.field('description')} />
      <FieldGrid>
        <SelectField
          label="Category"
          options={categoryOptions}
          value={form.values.categoryId}
          onChange={(v) => form.set('categoryId', v)}
          error={form.errors.categoryId}
        />
        <SelectField
          label="Supplier"
          options={supplierOptions}
          value={form.values.supplierId}
          onChange={(v) => form.set('supplierId', v)}
          error={form.errors.supplierId}
        />
        <SelectField
          label="Unit of measure"
          options={unitOptions}
          value={form.values.unit}
          onChange={(v) => form.set('unit', v)}
          error={form.errors.unit}
          hint="Stock is counted in this unit."
        />
      </FieldGrid>
      <TextField
        label="Picture links"
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="https://…/front.jpg"
        hint="One https link per line, up to 8. The first is the main picture."
        value={form.values.imageUrls}
        onChangeText={(t) => form.set('imageUrls', t)}
        // The schema reports a bad link as `imageUrls.2`; show the first one here.
        error={
          Object.entries(form.errors).find(
            ([k]) => k === 'imageUrls' || k.startsWith('imageUrls.'),
          )?.[1]
        }
      />
    </>
  );
}
