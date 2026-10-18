import type { Product } from '@orderloop/contracts';
import { FormDialog, useToast } from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useFormState } from '../forms';
import { useApi } from '../runtime';
import { parseImageLinks, ProductDetailsFields } from './ProductDetailsFields';

function EditForm({ product, onClose }: { product: Product; onClose: () => void }) {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const form = useFormState({
    name: product.name,
    description: product.description ?? '',
    categoryId: product.categoryId ?? '',
    supplierId: product.supplierId ?? '',
    imageUrls: product.imageUrls.join('\n'),
    unit: product.unit as string,
  });

  async function submit() {
    const ok = await form.run(async () => {
      await api.products.update(product.id, {
        name: form.values.name,
        description: form.values.description.trim() || null,
        categoryId: form.values.categoryId || null,
        supplierId: form.values.supplierId || null,
        imageUrls: parseImageLinks(form.values.imageUrls),
        unit: form.values.unit as Product['unit'],
      });
      await queryClient.invalidateQueries({ queryKey: ['product'] });
      await queryClient.invalidateQueries({ queryKey: ['products'] });
    });
    if (ok) {
      toast.success('Product saved');
      onClose();
    }
  }
  return (
    <FormDialog
      open
      onClose={onClose}
      title="Edit product"
      onSubmit={submit}
      submitLabel="Save changes"
      busy={form.busy}
      error={form.formError}
    >
      <ProductDetailsFields form={form} />
    </FormDialog>
  );
}

export function ProductEditDialog({
  product,
  open,
  onClose,
}: {
  product: Product;
  open: boolean;
  onClose: () => void;
}) {
  return open ? <EditForm product={product} onClose={onClose} /> : null;
}
