import { Alert, Button, Row, Stack, Text, useToast } from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '../../core/runtime';
import { messageFor } from '../../forms/errors';
import { invalidateTikTok } from '../../lib/tiktok';
import { VariantPicker, type PickedVariant } from '../catalog/VariantPicker';

/**
 * Link a TikTok SKU to one of your products, or clear the link. Choosing a product asks for a Save, then every order that was
 * waiting for this link is looked at again at once. Clearing a link does not touch stock that is already reserved.
 */
export function MapSkuControl({
  linkId,
  skuLabel,
  mapped,
}: {
  /** The SKU link to change. */
  linkId: string;
  /** Names the controls, so a page with many of them has distinct names: the seller SKU, or TikTok's SKU id. */
  skuLabel: string;
  /** Whether the SKU is linked now (then it can be changed or cleared). */
  mapped: boolean;
}) {
  const api = useApi();
  const toast = useToast();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<PickedVariant | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');

  async function save(variantId: string | null) {
    setBusy(true);
    setFailure('');
    try {
      const done = await api.tiktokSkuLinks.update(linkId, variantId);
      await invalidateTikTok(client);
      toast.success(
        variantId === null
          ? 'Link cleared'
          : done.reconciledOrders === 0
            ? 'Mapping saved'
            : `${done.reconciledOrders} waiting ${done.reconciledOrders === 1 ? 'order was' : 'orders were'} processed`,
      );
      setOpen(false);
      setChosen(null);
    } catch (e) {
      setFailure(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack gap={2}>
      {!!failure && <Alert tone="error">{failure}</Alert>}
      <Row gap={2} wrap>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          accessibilityLabel={
            mapped ? `Change product, SKU ${skuLabel}` : `Map to a product: SKU ${skuLabel}`
          }
          onPress={() => setOpen(!open)}
        >
          {mapped ? 'Change product' : 'Map to a product'}
        </Button>
        {mapped && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            accessibilityLabel={`Clear link, SKU ${skuLabel}`}
            onPress={() => save(null)}
          >
            Clear link
          </Button>
        )}
      </Row>
      {open && !chosen && (
        <VariantPicker
          label={`Find a product for SKU ${skuLabel}`}
          actionLabel="Use this product"
          onPick={setChosen}
        />
      )}
      {open && chosen && (
        <Stack gap={2}>
          <Text verbatim weight="medium">{`${chosen.label} · ${chosen.sku}`}</Text>
          <Row gap={2} wrap>
            <Button
              size="sm"
              loading={busy}
              accessibilityLabel={`Save mapping, SKU ${skuLabel}`}
              onPress={() => save(chosen.id)}
            >
              Save mapping
            </Button>
            <Button size="sm" variant="tertiary" disabled={busy} onPress={() => setChosen(null)}>
              Choose another
            </Button>
          </Row>
        </Stack>
      )}
    </Stack>
  );
}
