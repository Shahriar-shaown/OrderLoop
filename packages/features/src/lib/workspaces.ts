import {
  CURRENCIES,
  TIMEZONES,
  UpdateTenantBody,
  type AuthResult,
  type UpdateTenantBody as UpdateTenant,
} from '@orderloop/contracts';
import type { SelectOption } from '@orderloop/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { useAuth } from '../core/auth';
import { useRuntime } from '../core/runtime';

export const LANGUAGE_OPTIONS: SelectOption[] = [
  { value: 'en', label: 'English' },
  { value: 'bn', label: 'বাংলা (Bangla)' },
];
export const CURRENCY_OPTIONS: SelectOption[] = CURRENCIES.map((c) => ({ value: c, label: c }));
export const TIMEZONE_OPTIONS: SelectOption[] = TIMEZONES.map((z) => ({
  value: z,
  label: z.replace(/_/g, ' '),
}));

/** Optional profile fields: a blank box means "no value", which the API stores as null. */
const OPTIONAL_KEYS = [
  'logoUrl',
  'contactEmail',
  'contactPhone',
  'addressLine1',
  'addressLine2',
  'city',
  'district',
  'postalCode',
] as const;

/** The settings form: the API's own rules (UpdateTenantBody), applied after turning blank optional boxes into null. */
export const BusinessProfileForm = z.preprocess((raw) => {
  if (typeof raw !== 'object' || raw === null) return raw;
  const out: Record<string, unknown> = { ...raw };
  for (const key of OPTIONAL_KEYS) {
    const v = out[key];
    if (typeof v === 'string' && v.trim() === '') out[key] = null;
  }
  return out;
}, UpdateTenantBody);

export type BusinessProfileValues = Record<(typeof OPTIONAL_KEYS)[number], string> &
  Required<Pick<UpdateTenant, 'name' | 'country' | 'currency' | 'timezone' | 'defaultLanguage'>>;

export function useWorkspaces() {
  const { api } = useRuntime();
  const { session } = useAuth();
  // Keyed by user so one person's list is never shown to the next person on a shared device.
  return useQuery({
    queryKey: ['workspaces', session?.user.id],
    queryFn: () => api.workspaces.list(),
    enabled: Boolean(session),
  });
}

export function useBusiness() {
  const { api } = useRuntime();
  const { session } = useAuth();
  return useQuery({
    queryKey: ['tenant', session?.tenant.id],
    queryFn: () => api.tenant(),
    enabled: Boolean(session),
  });
}

/**
 * Move the session into another business the person belongs to. The API checks membership; on success every cached
 * answer belonging to the old business is dropped so no screen can show it under the new one.
 */
export function useSwitchWorkspace() {
  const { api, session: manager } = useRuntime();
  const queryClient = useQueryClient();
  return async (tenantId: string): Promise<AuthResult> => {
    const result = await api.auth.switchTenant(tenantId);
    manager.update(result);
    queryClient.clear();
    return result;
  };
}
