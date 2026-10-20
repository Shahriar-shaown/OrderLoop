import type { Analytics } from '@orderloop/contracts';
import { AreaChart, Stack, Text } from '@orderloop/ui';
import { formatShortDay, formatWeekdayDay } from '../../lib/format';
import { formatPrice, formatPriceShort } from '../../lib/money';

/**
 * Delivered revenue and gross profit per day. Gross profit is before courier charges and other costs, and a day whose
 * delivered items include one with no cost price has no gross profit (a gap, not zero).
 */
export function SalesProfitChart({
  days,
  from,
  to,
}: {
  days: Analytics['daily'];
  from: string;
  to: string;
}) {
  return (
    <Stack gap={3}>
      <AreaChart
        title={`Sales and profit per day, ${formatShortDay(from)} to ${formatShortDay(to)}`}
        labels={days.map((x) => formatShortDay(x.date))}
        tooltipTitle={(i) => formatWeekdayDay(days[i]!.date)}
        series={[
          { key: 'rev', label: 'Revenue', values: days.map((x) => x.revenueMinor), area: true },
          {
            key: 'gp',
            label: 'Gross profit (before courier charges and other costs)',
            values: days.map((x) => x.grossProfitMinor),
          },
        ]}
        format={formatPrice}
        formatAxis={formatPriceShort}
      />
      <Text variant="caption" tone="muted">
        A gap in the gross profit line means a delivered item that day has no cost price.
      </Text>
    </Stack>
  );
}
