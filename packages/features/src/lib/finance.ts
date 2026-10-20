import type {
  BatchStatus,
  CashState,
  CostKind,
  DiscrepancyType,
  SettlementMatchStatus,
} from '@orderloop/contracts';
import type { Tone } from '@orderloop/ui';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { invalidateOrders } from './orders';
import { useApi } from '../core/runtime';

export const MATCH_LABEL: Record<SettlementMatchStatus, string> = {
  matched: 'Matched',
  unmatched: 'Not matched',
  ambiguous: 'Needs a person',
  unallocated: 'No parcel (a charge)',
  duplicate: 'Duplicate (not counted)',
  ignored: 'Set aside',
};
export const MATCH_TONE: Record<SettlementMatchStatus, Tone> = {
  matched: 'success',
  unmatched: 'error',
  ambiguous: 'warning',
  unallocated: 'neutral',
  duplicate: 'neutral',
  ignored: 'neutral',
};

export const BATCH_LABEL: Record<BatchStatus, string> = {
  reconciled: 'Reconciled',
  ready: 'Ready',
  needs_attention: 'Needs attention',
};
export const BATCH_TONE: Record<BatchStatus, Tone> = {
  reconciled: 'success',
  ready: 'info',
  needs_attention: 'warning',
};

export const DISCREPANCY_LABEL: Record<DiscrepancyType, string> = {
  short_paid: 'Shortfall',
  over_paid: 'Overpaid',
  cash_before_delivery: 'Cash before delivery',
  cash_on_closed_order: 'Cash on a cancelled or returned order',
  fee_differs: 'Charge differs from booking',
  file_arithmetic: 'File does not add up',
};

export const CASH_LABEL: Record<CashState, string> = {
  paid: 'Paid',
  partial: 'Partly paid',
  unpaid: 'No remittance',
  overpaid: 'Overpaid',
  awaiting_delivery: 'Not yet delivered',
  not_due: 'Nothing due',
  cash_before_delivery: 'Cash before delivery',
  cash_on_closed_order: 'Cash on closed order',
};
export const CASH_TONE: Record<CashState, Tone> = {
  paid: 'success',
  partial: 'warning',
  unpaid: 'error',
  overpaid: 'warning',
  awaiting_delivery: 'info',
  not_due: 'neutral',
  cash_before_delivery: 'warning',
  cash_on_closed_order: 'warning',
};

export const COST_LABEL: Record<CostKind, string> = {
  packaging: 'Packaging',
  advertising: 'Advertising',
  delivery_charge: 'Delivery charge',
  return_charge: 'Return charge',
  courier_deduction: 'Courier deduction',
  other: 'Other',
};

export const SOURCE_LABEL: Record<string, string> = {
  orders: 'From your orders',
  settlements: 'From courier statements',
  manual_costs: 'Entered by hand',
  catalog_costs: 'From product cost prices',
  derived: 'Worked out from the figures above',
};

export const GROUP_LABEL: Record<string, string> = {
  sales: 'Sales',
  revenue: 'Revenue',
  cash: 'Cash',
  outstanding: 'Outstanding COD',
  expenses: 'Expenses',
  profit: 'Estimated profit',
};

export const useFinanceSummary = (from: string, to: string) => {
  const api = useApi();
  return useQuery({
    queryKey: ['finance', 'summary', from, to],
    queryFn: () => api.finance.summary({ from, to }),
  });
};
export const useOutstanding = () => {
  const api = useApi();
  return useQuery({
    queryKey: ['finance', 'outstanding'],
    queryFn: () => api.finance.outstanding(),
  });
};
export const useBatches = () => {
  const api = useApi();
  return useQuery({ queryKey: ['finance', 'batches'], queryFn: () => api.finance.batches() });
};
export const useBatch = (id: string) => {
  const api = useApi();
  return useQuery({ queryKey: ['finance', 'batch', id], queryFn: () => api.finance.batch(id) });
};

export const useUnmatched = () => {
  const api = useApi();
  return useQuery({ queryKey: ['finance', 'unmatched'], queryFn: () => api.finance.unmatched() });
};
export const useOpenDiscrepancies = () => {
  const api = useApi();
  return useQuery({
    queryKey: ['finance', 'discrepancies', 'open'],
    queryFn: () => api.finance.discrepancies({ status: 'open' }),
  });
};

/** Money figures depend on one another, so a change anywhere refreshes them all (and the orders and shipments they read). */
export const invalidateFinance = async (client: QueryClient) => {
  await Promise.all([
    client.invalidateQueries({ queryKey: ['finance'] }),
    invalidateOrders(client),
  ]);
};
