import { UNITS } from '@orderloop/contracts';
import { FieldGrid, SelectField, TextField } from '@orderloop/ui';
import { useMemo } from 'react';
import { useCategories } from '../hooks';
import type { FormState } from '../forms';

export type ProductDetailValues = {
  name: string;
  description: string;
  categoryId: string;
  unit: string;
};

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
          label="Unit of measure"
          options={unitOptions}
          value={form.values.unit}
          onChange={(v) => form.set('unit', v)}
          error={form.errors.unit}
          hint="Stock is counted in this unit."
        />
      </FieldGrid>
    </>
  );
}
