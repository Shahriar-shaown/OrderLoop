import type { TikTokVariantRef } from '@orderloop/contracts';
import { Link, Text } from '@orderloop/ui';
import { useQuery } from '@tanstack/react-query';
import { useCan } from '../../core/permissions';
import { useApi } from '../../core/runtime';
import { variantLabel } from '../../lib/format';

/**
 * The OrderLoop product a TikTok SKU is linked to. It links to the product's page when that can be found by its SKU (the order
 * only carries the variant, not the product); otherwise it is plain text, never a dead link.
 */
export function VariantText({ variant }: { variant: TikTokVariantRef }) {
  const api = useApi();
  const can = useCan();
  const found = useQuery({
    queryKey: ['products', 'by-variant', variant.id],
    enabled: can('catalog:read'),
    retry: false,
    staleTime: 5 * 60_000,
    queryFn: () => api.products.list({ limit: 5, q: variant.sku }),
  });
  const product = found.data?.items.find((p) => p.variants.some((v) => v.id === variant.id));
  const text = `${variantLabel(variant.productName, variant.variantName)} · ${variant.sku}`;
  return product ? (
    <Link href={`/products/${product.id}`} weight="medium">
      {text}
    </Link>
  ) : (
    <Text weight="medium" verbatim>
      {text}
    </Text>
  );
}
