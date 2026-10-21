import type { SocialDraft } from '@orderloop/contracts';
import { CHECK_THIS_CONFIDENCE, formatBdPhone } from '@orderloop/domain';
import { Badge, KeyValueList, Row, Section, Stack, Text } from '@orderloop/ui';
import { formatPrice } from '../../lib/money';
import { variantLabel } from '../../lib/format';

/** A draft as plain facts, for someone who cannot change it (or when it is closed): what was found and the catalogue's prices. */
export function DraftReadOnly({ draft }: { draft: SocialDraft }) {
  const f = draft.fields;
  const row = (
    label: string,
    field: { value: string; confidence: number; edited: boolean } | undefined,
    phone = false,
  ) => ({
    label,
    value: field ? (
      <Row gap={2} wrap>
        <Text>{phone ? formatBdPhone(field.value) : field.value}</Text>
        {!field.edited && field.confidence < CHECK_THIS_CONFIDENCE && (
          <Badge tone="warning">Check this</Badge>
        )}
      </Row>
    ) : (
      <Text tone="muted">Not found</Text>
    ),
  });
  return (
    <Stack gap={5}>
      <Section title="Details found in the messages">
        <KeyValueList
          items={[
            row('Customer name', f.customerName),
            row('Phone', f.phone, true),
            row('Address', f.address),
            ...(f.area ? [row('Thana / upazila', f.area)] : []),
            row('District', f.district),
            ...(f.postalCode ? [row('Postal code', f.postalCode)] : []),
            ...(f.note ? [row('Note', f.note)] : []),
          ]}
        />
      </Section>
      <Section title="Products">
        <Stack gap={3}>
          {f.items.length === 0 && <Text tone="muted">No products were found.</Text>}
          {f.items.map((item, i) => (
            <Stack key={`${item.text}-${i}`} gap={1}>
              {item.match ? (
                <>
                  <Text weight="medium">{`${variantLabel(item.match.productName, item.match.variantName)} × ${item.quantity}`}</Text>
                  <Text variant="caption" tone="muted">
                    {`${item.match.sku} · ${formatPrice(item.match.priceMinor)} each, from your catalogue`}
                  </Text>
                </>
              ) : (
                <>
                  <Text weight="medium">{`“${item.text}” × ${item.quantity}`}</Text>
                  <Badge tone="warning">Not matched to a product</Badge>
                </>
              )}
            </Stack>
          ))}
        </Stack>
      </Section>
    </Stack>
  );
}
