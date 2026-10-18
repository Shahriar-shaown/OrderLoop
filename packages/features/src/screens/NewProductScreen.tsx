import { ProductBody } from '@orderloop/contracts';
import {
  Alert,
  Button,
  Form,
  PageHeader,
  Section,
  Stack,
  Text,
  useNavigation,
  useToast,
} from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { FormError } from '../components/FormError';
import { parseImageLinks, ProductDetailsFields } from '../components/ProductDetailsFields';
import { VariantFields } from '../components/VariantFields';
import { validate, type FormErrors } from '../errors';
import { useFormState } from '../forms';
import { useCan } from '../permissions';
import { useApi } from '../runtime';
import { emptyVariant, toVariantInput, type VariantValues } from '../variants';

export function NewProductScreen() {
  const api = useApi();
  const can = useCan();
  const navigation = useNavigation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const form = useFormState({
    name: '',
    description: '',
    categoryId: '',
    supplierId: '',
    imageUrls: '',
    unit: 'pcs',
  });
  const [variants, setVariants] = useState<VariantValues[]>(() => [emptyVariant()]);

  if (!can('catalog:write'))
    return <Alert tone="warning">Your role can view the catalog but not change it.</Alert>;

  async function submit() {
    const localErrors: FormErrors = {};
    const items = variants.map((v, i) => {
      const { value, errors } = toVariantInput(v, `variants.${i}`);
      Object.assign(localErrors, errors);
      return value;
    });
    const description = form.values.description.trim();
    const checked = validate(ProductBody, {
      name: form.values.name,
      unit: form.values.unit,
      ...(description ? { description } : {}),
      ...(form.values.categoryId ? { categoryId: form.values.categoryId } : {}),
      ...(form.values.supplierId ? { supplierId: form.values.supplierId } : {}),
      imageUrls: parseImageLinks(form.values.imageUrls),
      variants: items,
    });
    form.setFormError('');
    // The specific price message above beats the generic schema one for the same field.
    if (Object.keys(localErrors).length || !checked.data)
      return form.setErrors({ ...(checked.errors ?? {}), ...localErrors });
    const body = checked.data;
    let createdId = '';
    const ok = await form.run(async () => {
      const product = await api.products.create(body);
      createdId = product.id;
      await queryClient.invalidateQueries({ queryKey: ['products'] });
      toast.success(`Created ${product.name}`);
    });
    if (ok) navigation.push(`/products/${createdId}`);
  }

  return (
    <Stack gap={5}>
      <PageHeader
        title="New product"
        actions={
          <Button href="/products" variant="secondary">
            Cancel
          </Button>
        }
      />
      <Form onSubmit={submit} gap={5}>
        <FormError message={form.formError} />
        <Section title="Details">
          <ProductDetailsFields form={form} />
        </Section>
        <Section
          title="Variants"
          description="Each variant is something you can stock and sell, such as a size or colour."
          actions={
            <Button variant="secondary" onPress={() => setVariants((v) => [...v, emptyVariant()])}>
              Add another variant
            </Button>
          }
        >
          {form.errors.variants ? <Alert tone="error">{form.errors.variants}</Alert> : null}
          {variants.map((v, i) => (
            <Stack key={v.key} gap={3}>
              <Text weight="bold">Variant {i + 1}</Text>
              <VariantFields
                value={v}
                prefix={`variants.${i}`}
                errors={form.errors}
                onChange={(next) => setVariants((all) => all.map((x, j) => (j === i ? next : x)))}
              />
              {variants.length > 1 && (
                <Stack align="start">
                  <Button
                    variant="ghost"
                    size="sm"
                    onPress={() => setVariants((all) => all.filter((_, j) => j !== i))}
                  >
                    Remove variant {i + 1}
                  </Button>
                </Stack>
              )}
            </Stack>
          ))}
        </Section>
        <Stack align="start">
          <Button type="submit" loading={form.busy}>
            Create product
          </Button>
        </Stack>
      </Form>
    </Stack>
  );
}
