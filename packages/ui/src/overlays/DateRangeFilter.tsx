import { View } from 'react-native';
import { Button } from '../Button';
import { isRealDay } from '../data/day';
import { FilterChip } from './FilterChip';
import { Popover } from './Popover';
import { Row, Stack } from '../layout/Stack';
import { TextField } from '../inputs/TextField';

export interface DatePreset {
  label: string;
  from: string;
  to: string;
}

/**
 * A filter chip for a range of days: "Date: Any" or "Date: 1 Oct – 17 Oct". The panel has two YYYY-MM-DD boxes and optional
 * presets ("Last 7 days"). The screen keeps the raw text of both boxes and only uses a value that is a valid day.
 */
export function DateRangeFilter({
  from,
  to,
  onChange,
  presets = [],
  format = (day) => day,
}: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  presets?: DatePreset[];
  /** How a day is shown on the chip. */
  format?: (day: string) => string;
}) {
  const start = isRealDay(from) ? format(from) : '';
  const end = isRealDay(to) ? format(to) : '';
  const active = start !== '' || end !== '';
  const text = !active ? 'Date: Any' : `Date: ${start || '…'} – ${end || '…'}`;
  return (
    <Popover
      haspopup="dialog"
      width={300}
      trigger={(p) => <FilterChip text={text} active={active} popover={p} />}
    >
      {(close) => (
        <View style={{ padding: 8 }}>
          <Stack gap={3}>
            <Row gap={2} align="start">
              <View style={{ flex: 1 }}>
                <TextField
                  label="From date"
                  placeholder="2026-10-01"
                  autoCapitalize="none"
                  value={from}
                  onChangeText={(t) => onChange(t, to)}
                  error={
                    from && !isRealDay(from)
                      ? 'Use a real date, as YYYY-MM-DD'
                      : isRealDay(from) && isRealDay(to) && from > to
                        ? 'Starts after the end date'
                        : undefined
                  }
                />
              </View>
              <View style={{ flex: 1 }}>
                <TextField
                  label="To date"
                  placeholder="2026-10-31"
                  autoCapitalize="none"
                  value={to}
                  onChangeText={(t) => onChange(from, t)}
                  error={to && !isRealDay(to) ? 'Use a real date, as YYYY-MM-DD' : undefined}
                />
              </View>
            </Row>
            {presets.length > 0 && (
              <Row gap={2} wrap>
                {presets.map((p) => (
                  <Button
                    key={p.label}
                    size="sm"
                    variant="secondary"
                    onPress={() => {
                      onChange(p.from, p.to);
                      close();
                    }}
                  >
                    {p.label}
                  </Button>
                ))}
              </Row>
            )}
            <Row gap={2} justify="between">
              <Button
                size="sm"
                variant="ghost"
                disabled={!from && !to}
                onPress={() => {
                  onChange('', '');
                  close();
                }}
              >
                Clear dates
              </Button>
              <Button size="sm" onPress={close}>
                Done
              </Button>
            </Row>
          </Stack>
        </View>
      )}
    </Popover>
  );
}
