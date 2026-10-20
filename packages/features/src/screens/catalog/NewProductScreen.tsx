import { ProductBody } from '@orderloop/contracts';
import {
  Alert,
  Button,
  Card,
  Form,
  KeyValueList,
  PageHeader,
  Row,
  Section,
  Split,
  Stack,
  Text,
  useNavigation,
  useToast,
} from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { FormError } from '../../forms/FormError';
import {
  parseImageLinks,
  ProductDetailsFields,
} from '../../components/catalog/ProductDetailsFields';
import { VariantFields } from '../../components/catalog/VariantFields';
import { validate, type FormErrors } from '../../forms/errors';
import { useFormState } from '../../forms/forms';
import { formatPrice, parsePrice } from '../../lib/money';
import { useCan } from '../../core/permissions';
import { useApi } from '../../core/runtime';
import { emptyVariant, toVariantInput, type VariantValues } from '../../lib/variants';

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
    if (ok) navigation.replace(`/products/${createdId}`);
  }

  const prices = variants.map((v) => parsePrice(v.price)).filter((n): n is number => n !== null);
  const priceSummary =
    prices.length === 0
      ? '—'
      : Math.min(...prices) === Math.max(...prices)
        ? formatPrice(prices[0] ?? 0)
        : `${formatPrice(Math.min(...prices))} – ${formatPrice(Math.max(...prices))}`;

  return (
    <Stack gap={5}>
      <PageHeader
        title="New product"
        description="Add what you sell, then give it one or more variants (SKUs) that carry the price and the stock."
        breadcrumbs={[{ label: 'Products', href: '/products' }, { label: 'New product' }]}
      />
      <Form onSubmit={submit} gap={5}>
        <FormError message={form.formError} />
        <Split
          sticky
          main={
            <>
              <Section title="Details">
                <ProductDetailsFields form={form} />
              </Section>
              <Section
                title="Variants"
                description="Each variant is something you can stock and sell, such as a size or colour."
                actions={
                  <Button
                    variant="secondary"
                    icon="plus"
                    onPress={() => {
                      setVariants((v) => [...v, emptyVariant()]);
                      form.clearFor('variants');
                    }}
                  >
                    Add another variant
                  </Button>
                }
              >
                {form.errors.variants ? <Alert tone="error">{form.errors.variants}</Alert> : null}
                {variants.map((v, i) => (
                  <Card key={v.key} variant="filled" padding="md">
                    <Stack gap={3}>
                      <Row justify="between" align="center" gap={2}>
                        <Text variant="heading">{`Variant ${i + 1}`}</Text>
                        {variants.length > 1 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onPress={() => {
                              setVariants((all) => all.filter((_, j) => j !== i));
                              form.clearFor('variants');
                            }}
                          >
                            {`Remove variant ${i + 1}`}
                          </Button>
                        )}
                      </Row>
                      <VariantFields
                        value={v}
                        prefix={`variants.${i}`}
                        errors={form.errors}
                        onEdit={form.clearFor}
                        onChange={(next) =>
                          setVariants((all) => all.map((x, j) => (j === i ? next : x)))
                        }
                      />
                    </Stack>
                  </Card>
                ))}
              </Section>
            </>
          }
          aside={
            <Card variant="outlined" padding="md">
              <Stack gap={4}>
                <Text variant="title" role="heading" aria-level={2}>
                  Summary
                </Text>
                <KeyValueList
                  layout="inline"
                  items={[
                    { label: 'Product', value: form.values.name.trim() || '—' },
                    { label: 'Variants', value: String(variants.length) },
                    { label: 'Price', value: priceSummary },
                  ]}
                />
                <Stack gap={2}>
                  <Button type="submit" loading={form.busy} fullWidth>
                    Create product
                  </Button>
                  <Button href="/products" variant="secondary" fullWidth>
                    Cancel
                  </Button>
                </Stack>
              </Stack>
            </Card>
          }
        />
      </Form>
    </Stack>
  );
}
