import { Dialog, Icon, SearchField, Stack, Text, useNavigation, useTheme } from '@orderloop/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useDebounced } from '../hooks';
import { useCan } from '../permissions';
import { useApi } from '../runtime';

interface Hit {
  key: string;
  title: string;
  detail: string;
  href: string;
  icon: 'box' | 'users' | 'layers' | 'truck';
}

/**
 * Search across orders, customers, products and shipments from anywhere (⌘K / Ctrl+K on the web). It only asks for what the
 * person's role may read, and each result opens the thing itself.
 */
export function GlobalSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const api = useApi();
  const can = useCan();
  const navigation = useNavigation();
  const { colors } = useTheme();
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 250);
  useEffect(() => {
    if (!open) setText('');
  }, [open]);
  const query = useQuery({
    queryKey: ['global-search', q],
    enabled: open && q.length >= 2,
    queryFn: async (): Promise<Hit[]> => {
      const hits: Hit[] = [];
      const [orders, customers, products, shipments] = await Promise.all([
        can('orders:read') ? api.orders.list({ q, limit: 5 } as never) : null,
        can('orders:read') ? api.customers.list({ q, limit: 5 } as never) : null,
        can('catalog:read') ? api.products.list({ q, limit: 5 } as never) : null,
        can('couriers:read') ? api.shipments.list({ q, limit: 5 } as never) : null,
      ]);
      for (const o of orders?.items ?? [])
        hits.push({
          key: `o${o.id}`,
          title: `Order #${o.orderNumber} · ${o.customerName}`,
          detail: o.itemsSummary || o.phone,
          href: `/orders/${o.id}`,
          icon: 'box',
        });
      for (const c of customers?.items ?? [])
        hits.push({
          key: `c${c.id}`,
          title: c.name,
          detail: c.phone,
          href: `/customers/${c.id}`,
          icon: 'users',
        });
      for (const p of products?.items ?? [])
        hits.push({
          key: `p${p.id}`,
          title: p.name,
          detail: p.variants
            .map((v) => v.sku)
            .slice(0, 3)
            .join(' · '),
          href: `/products/${p.id}`,
          icon: 'layers',
        });
      for (const s of shipments?.items ?? [])
        hits.push({
          key: `s${s.id}`,
          title: `Shipment ${s.consignmentId ?? s.reference}`,
          detail: `Order #${s.orderNumber} · ${s.customerName}`,
          href: `/orders/${s.orderId}`,
          icon: 'truck',
        });
      return hits;
    },
  });
  const go = (href: string) => {
    onClose();
    navigation.push(href);
  };
  return (
    <Dialog open={open} onClose={onClose} title="Search">
      <Stack gap={3}>
        <SearchField
          label="Search orders, customers, products and tracking IDs"
          placeholder="Order number, name, phone, SKU or tracking ID"
          value={text}
          onChangeText={setText}
          autoFocus
        />
        {q.length < 2 ? (
          <Text tone="muted">Type at least two characters.</Text>
        ) : query.isLoading ? (
          <Text tone="muted">Searching…</Text>
        ) : query.data && query.data.length > 0 ? (
          <View role="list">
            {query.data.map((h) => (
              <Pressable
                key={h.key}
                role="listitem"
                onPress={() => go(h.href)}
                style={(s) => [
                  {
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    minHeight: 52,
                    paddingHorizontal: 8,
                    borderRadius: 8,
                  },
                  (s as { hovered?: boolean }).hovered ? { backgroundColor: colors.subtle } : null,
                ]}
              >
                <Icon name={h.icon} size={18} color={colors.muted} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text variant="label" numberOfLines={1}>
                    {h.title}
                  </Text>
                  <Text variant="caption" tone="muted" numberOfLines={1}>
                    {h.detail}
                  </Text>
                </View>
              </Pressable>
            ))}
          </View>
        ) : (
          <Text tone="muted">{`Nothing found for “${q}”.`}</Text>
        )}
      </Stack>
    </Dialog>
  );
}

/** ⌘K / Ctrl+K opens the search (web). */
export function useSearchShortcut(open: () => void) {
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        open();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
}
