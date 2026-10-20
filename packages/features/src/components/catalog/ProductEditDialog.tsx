import type { Product } from '@orderloop/contracts';
import { FormDialog, useToast } from '@orderloop/ui';
import { invalidateCatalog } from '../../lib/invalidate';
import { useQueryClient } from '@tanstack/react-query';
import { useFormState } from '../../forms/forms';
import { useApi } from '../../core/runtime';
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
      await invalidateCatalog(queryClient);
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
      icon="edit"
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
