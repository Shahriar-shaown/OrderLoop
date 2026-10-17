import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { Text } from './Text';
import { useTheme } from './theme';
import { radius, space } from './tokens';

const renderCell = (content: ReactNode) =>
  typeof content === 'string' || typeof content === 'number' ? <Text>{content}</Text> : content;

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right';
  /** Share of the free width (default 1). */
  flex?: number;
  /** The column never gets narrower than this; below the table's total minimum it scrolls sideways. */
  minWidth?: number;
}

/**
 * A table that exposes table semantics to assistive technology on the web (`role="table"`, rows, column headers) and
 * scrolls sideways on narrow screens instead of squeezing columns. Cells hold anything: text, a Badge, a Link.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  label,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  label: string;
}) {
  const { colors } = useTheme();
  const minTotal = columns.reduce((n, c) => n + (c.minWidth ?? 120), 0);
  const cell = (c: Column<T>) => ({
    flexGrow: c.flex ?? 1,
    flexBasis: c.minWidth ?? 120,
    minWidth: c.minWidth ?? 120,
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    justifyContent: 'center' as const,
    alignItems: c.align === 'right' ? ('flex-end' as const) : ('flex-start' as const),
  });
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.lg,
        overflow: 'hidden',
      }}
    >
      <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ flexGrow: 1 }}>
        <View role="table" aria-label={label} style={{ minWidth: minTotal, flexGrow: 1 }}>
          <View
            role="row"
            style={{
              flexDirection: 'row',
              backgroundColor: colors.surface,
              borderBottomWidth: 1,
              borderBottomColor: colors.border,
            }}
          >
            {columns.map((c) => (
              <View key={c.key} role="columnheader" style={cell(c)}>
                <Text variant="caption" weight="bold" tone="muted">
                  {c.header}
                </Text>
              </View>
            ))}
          </View>
          {rows.map((row, i) => (
            <View
              key={rowKey(row)}
              role="row"
              style={{
                flexDirection: 'row',
                borderBottomWidth: i === rows.length - 1 ? 0 : 1,
                borderBottomColor: colors.border,
              }}
            >
              {columns.map((c) => (
                <View key={c.key} role="cell" style={cell(c)}>
                  {renderCell(c.render(row))}
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
