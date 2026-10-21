import type { CustomerDetail } from '@orderloop/contracts';
import { formatBdPhone } from '@orderloop/domain';
import {
  Avatar,
  Badge,
  Button,
  Card,
  FieldGrid,
  Link,
  Row,
  SearchField,
  Section,
  Skeleton,
  Stack,
  Text,
  TextField,
  useTheme,
  useT,
} from '@orderloop/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable } from 'react-native';
import { useDebounced } from '../../lib/hooks';
import { formatPrice } from '../../lib/money';
import { useApi } from '../../core/runtime';

type FieldProps = { value: string; onChangeText: (t: string) => void; error?: string | undefined };

/** The chosen customer: who they are and what they have ordered before, in plain counts. */
function PickedCustomer({
  customer,
  onChange,
}: {
  customer: CustomerDetail;
  onChange?: (() => void) | undefined;
}) {
  const n = customer.stats.ordersCount;
  return (
    <Card variant="filled" padding="sm">
      <Row gap={3} justify="between" wrap>
        <Row gap={3} grow style={{ minWidth: 220 }}>
          <Avatar name={customer.name} size={40} />
          <Stack gap={1} grow>
            <Row gap={2} wrap>
              <Text weight="medium">{customer.name}</Text>
              {n > 0 && (
                <Badge tone="brand" dot>
                  Repeat customer
                </Badge>
              )}
            </Row>
            <Text variant="caption" tone="muted">
              {`${formatBdPhone(customer.phone)} · ${n} previous order${n === 1 ? '' : 's'}${n > 0 ? ` · ${formatPrice(customer.stats.deliveredValueMinor)} delivered` : ''}`}
            </Text>
            <Link href={`/customers/${customer.id}`} variant="inline">
              Open customer
            </Link>
          </Stack>
        </Row>
        {onChange && (
          <Button variant="tertiary" size="sm" onPress={onChange}>
            Change
          </Button>
        )}
      </Row>
    </Card>
  );
}

/**
 * Section 1 of the order form. Search existing customers by name or phone, or enter a new one (a phone number already on
 * file is the same customer: nobody is added twice). Editing an order shows its customer and nothing to change.
 */
export function OrderCustomerSection({
  fixed,
  picked,
  loading,
  mode,
  onMode,
  onPick,
  onClear,
  phone,
  name,
  phoneError,
  nameError,
  phoneHint,
  nameHint,
}: {
  /** An order being edited: its customer, not changeable here. */
  fixed?: { name: string; phone: string } | undefined;
  picked: CustomerDetail | null;
  loading: boolean;
  mode: 'search' | 'new';
  onMode: (mode: 'search' | 'new') => void;
  onPick: (id: string) => void;
  onClear: () => void;
  phone: FieldProps;
  name: FieldProps;
  phoneError?: string | undefined;
  nameError?: string | undefined;
  /** Replaces the phone box's usual hint (a draft says "check this"). */
  phoneHint?: string | undefined;
  nameHint?: string | undefined;
}) {
  const api = useApi();
  const { colors } = useTheme();
  const t = useT();
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const results = useQuery({
    queryKey: ['customers', 'search', q],
    enabled: !fixed && !picked && mode === 'search' && q.length >= 2,
    queryFn: () => api.customers.list({ q, limit: 5 }),
  });

  if (fixed)
    return (
      <Section title="1 · Customer">
        <Card variant="filled" padding="sm">
          <Row gap={3}>
            <Avatar name={fixed.name} size={40} />
            <Stack gap={1}>
              <Text weight="medium">{fixed.name}</Text>
              <Text variant="caption" tone="muted">
                {formatBdPhone(fixed.phone)}
              </Text>
            </Stack>
          </Row>
        </Card>
      </Section>
    );

  return (
    <Section
      title="1 · Customer"
      actions={
        picked || loading ? undefined : mode === 'search' ? (
          <Button variant="tertiary" size="sm" onPress={() => onMode('new')}>
            New customer
          </Button>
        ) : (
          <Button variant="tertiary" size="sm" onPress={() => onMode('search')}>
            Search customers
          </Button>
        )
      }
    >
      {picked ? (
        <PickedCustomer customer={picked} onChange={onClear} />
      ) : loading ? (
        <Skeleton width="60%" />
      ) : mode === 'search' ? (
        <Stack gap={3}>
          <SearchField
            label="Find a customer"
            placeholder="Search by name or phone, e.g. 01611…"
            value={search}
            onChangeText={setSearch}
          />
          {q.length >= 2 && results.data && results.data.items.length === 0 && (
            <Text tone="muted">
              No customer matches “{q}”. Use New customer to add them with this order.
            </Text>
          )}
          {results.data?.items.map((c) => (
            <Pressable
              key={c.id}
              role="button"
              aria-label={t('Use customer {name}', { name: c.name })}
              onPress={() => onPick(c.id)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                padding: 8,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface,
              }}
            >
              <Avatar name={c.name} />
              <Stack gap={1} grow>
                <Text weight="medium">{c.name}</Text>
                <Text variant="caption" tone="muted">
                  {`${formatBdPhone(c.phone)} · ${c.stats.ordersCount} order${c.stats.ordersCount === 1 ? '' : 's'}`}
                </Text>
              </Stack>
            </Pressable>
          ))}
        </Stack>
      ) : (
        <FieldGrid>
          <TextField
            label="Phone"
            required
            kind="text"
            keyboardType="phone-pad"
            placeholder="01712-345678"
            hint={phoneHint ?? 'A number already on file is matched to that customer.'}
            {...phone}
            error={phoneError}
          />
          <TextField
            label="Customer name"
            required
            {...name}
            error={nameError}
            {...(nameHint ? { hint: nameHint } : {})}
          />
        </FieldGrid>
      )}
    </Section>
  );
}
