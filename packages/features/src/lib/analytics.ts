import type {
  Analytics,
  CostKind,
  DashboardPeriod,
  FinanceFigure,
  FinanceSummary,
} from '@orderloop/contracts';
import { useQuery } from '@tanstack/react-query';
import { dayBefore, formatShortDay } from './format';
import { useApi } from '../core/runtime';

/** The three periods the dashboard and analytics offer. They are the only ones the API can answer for. */
export const PERIOD_ITEMS = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];
export const PERIOD_WORDS: Record<DashboardPeriod, string> = {
  today: 'today',
  '7d': 'in the last 7 days',
  '30d': 'in the last 30 days',
};
const PERIOD_DAYS: Record<DashboardPeriod, number> = { today: 1, '7d': 7, '30d': 30 };

/** First and last calendar day (YYYY-MM-DD) of a period ending today, in the viewer's calendar. */
export function periodRange(period: DashboardPeriod): { from: string; to: string } {
  return { from: dayBefore(PERIOD_DAYS[period] - 1), to: dayBefore(0) };
}

/** "11–17 Oct 2026" or "17 Oct 2026" for a range of calendar days. */
export function rangeInWords(from: string, to: string): string {
  const year = to.slice(0, 4);
  return from === to
    ? `${formatShortDay(to)} ${year}`
    : `${formatShortDay(from)} – ${formatShortDay(to)} ${year}`;
}

export const figureOf = (
  summary: FinanceSummary | undefined,
  key: string,
): FinanceFigure | undefined => summary?.figures.find((f) => f.key === key);
export const figureMinor = (summary: FinanceSummary | undefined, key: string): number =>
  figureOf(summary, key)?.amountMinor ?? 0;

/** Revenue delivered in the period: goods plus the delivery charge billed to customers. */
export const deliveredRevenue = (summary: FinanceSummary | undefined): number =>
  figureMinor(summary, 'revenue_goods') + figureMinor(summary, 'revenue_delivery');

/** Costs other than product cost, courier charges and advertising: other courier deductions, other recorded kinds, written-off COD. */
export function otherCostsMinor(summary: FinanceSummary): number {
  const manualOther = summary.manualCostsByKind
    .filter((k) => k.kind !== 'advertising')
    .reduce((n, k) => n + k.amountMinor, 0);
  return (
    figureMinor(summary, 'courier_other') + manualOther + figureMinor(summary, 'cod_written_off')
  );
}
export const adSpendMinor = (summary: FinanceSummary): number =>
  summary.manualCostsByKind
    .filter((k: { kind: CostKind }) => k.kind === 'advertising')
    .reduce((n, k) => n + k.amountMinor, 0);

export interface CostLine {
  key: string;
  label: string;
  amountMinor: number;
  /** The summary figure it comes from, when it is one (so its source can be shown). */
  figureKey?: string;
}

/** Every cost between delivered revenue and net profit, in the order of the waterfall. Null when product cost is unknown. */
export function costLines(summary: FinanceSummary): CostLine[] | null {
  const cogs = figureOf(summary, 'cogs');
  if (!cogs) return null;
  return [
    { key: 'cogs', label: 'Product cost', amountMinor: cogs.amountMinor, figureKey: 'cogs' },
    {
      key: 'courier_delivery',
      label: 'Courier delivery charges',
      amountMinor: figureMinor(summary, 'courier_delivery'),
      figureKey: 'courier_delivery',
    },
    {
      key: 'courier_cod_fee',
      label: 'COD handling fees',
      amountMinor: figureMinor(summary, 'courier_cod_fee'),
      figureKey: 'courier_cod_fee',
    },
    {
      key: 'courier_return',
      label: 'Return charges',
      amountMinor: figureMinor(summary, 'courier_return'),
      figureKey: 'courier_return',
    },
    { key: 'ads', label: 'Advertising', amountMinor: adSpendMinor(summary) },
    { key: 'other', label: 'Other costs', amountMinor: otherCostsMinor(summary) },
  ];
}

/** Profit as a share of delivered revenue (0..1). Null when profit is unknown or there was no revenue. */
export function profitMargin(summary: FinanceSummary | undefined): number | null {
  const revenue = deliveredRevenue(summary);
  if (!summary || summary.estimatedProfitMinor === null || revenue <= 0) return null;
  return summary.estimatedProfitMinor / revenue;
}

export const percentOf = (part: number, whole: number): string =>
  whole > 0 ? `${(Math.round((part / whole) * 1000) / 10).toFixed(1)}%` : '—';
export const percent = (rate: number): string => `${Math.round(rate * 1000) / 10}%`;

export function useAnalytics(from: string, to: string, enabled = true) {
  const api = useApi();
  return useQuery<Analytics>({
    queryKey: ['finance', 'analytics', from, to],
    queryFn: () => api.finance.analytics({ from, to }),
    enabled,
  });
}

/** "Good morning" / "Good afternoon" / "Good evening" for the viewer's local hour. */
export function greeting(now: Date = new Date()): string {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
