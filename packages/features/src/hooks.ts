import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useApi } from './runtime';

/** A value that only changes after it has been stable for `ms`: keeps search boxes from querying on every keystroke. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export function useCategories() {
  const api = useApi();
  return useQuery({ queryKey: ['categories'], queryFn: () => api.categories.list() });
}
export function useLocations() {
  const api = useApi();
  return useQuery({ queryKey: ['locations'], queryFn: () => api.locations.list() });
}
export function useProduct(id: string) {
  const api = useApi();
  return useQuery({ queryKey: ['product', id], queryFn: () => api.products.get(id) });
}

/** A fresh random key per call: sending it with a stock change makes an accidental double-submit harmless. */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  const id = c?.randomUUID
    ? c.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `app-${id}`;
}
