import type { ReactNode } from 'react';
import {
  Pressable,
  ScrollView,
  View,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Checkbox } from '../inputs/Checkbox';
import { Skeleton } from '../feedback/Skeleton';
import { useT } from '../i18n';
import { Text } from '../Text';
import { useTheme } from '../theme/theme';
import { radius, space } from '../theme/tokens';
import { useBreakpoint, type Breakpoint } from '../layout/useBreakpoint';

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
  /** The narrowest layout that shows this column: `always` (default), `wide` (tablet and up) or `desktop` only. */
  show?: 'always' | 'wide' | 'desktop';
}

const RANK: Record<Breakpoint, number> = { mobile: 0, tablet: 1, desktop: 2 };
const NEEDS = { always: 0, wide: 1, desktop: 2 } as const;

export interface Selection {
  selected: string[];
  onChange: (ids: string[]) => void;
}

type KeyEvent = { key: string; target: unknown; currentTarget: unknown; preventDefault(): void };

/** Space presses the row (web only: native has no keyboard focus). Only the row's own Space: one typed in a field inside it is not a press. */
const pressOnSpace = (onPress: () => void) => (event: KeyEvent) => {
  if (event.key === ' ' && event.target === event.currentTarget) {
    event.preventDefault();
    onPress();
  }
};

/**
 * A table row or card. Only a row that can be pressed is a `Pressable`: a disabled one would mark itself `aria-disabled`, and
 * everything inside it (the row's own action buttons) with it. A pressable row is reachable by keyboard whatever its role:
 * Tab focuses it, Enter (by the Pressable) and Space (here: it is only a native button key) open it.
 */
function RowShell({
  onPress,
  style,
  children,
  role,
  label,
}: {
  onPress: (() => void) | undefined;
  style: StyleProp<ViewStyle> | ((state: PressableStateCallbackType) => StyleProp<ViewStyle>);
  children: ReactNode;
  role: 'row' | 'listitem';
  label?: string | undefined;
}) {
  const t = useT();
  if (!onPress) {
    const plain =
      typeof style === 'function' ? style({ pressed: false } as PressableStateCallbackType) : style;
    return (
      <View role={role} style={plain}>
        {children}
      </View>
    );
  }
  return (
    <Pressable
      role={role}
      focusable
      aria-label={label && t(label)}
      onPress={onPress}
      {...({ onKeyDown: pressOnSpace(onPress) } as object)}
      style={style}
    >
      {children}
    </Pressable>
  );
}

/**
 * A table that exposes table semantics to assistive technology on the web (`role="table"`, rows, column headers). On a
 * desktop it shows every column; on a tablet the columns marked `desktop` are left out; on a phone, if `renderCard` is given,
 * each row becomes a card (ID, customer, total, status), otherwise the table scrolls sideways instead of squeezing columns.
 * Cells hold anything: text, a Badge, a Link. `selection` adds row checkboxes and a select-all box.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  label,
  selection,
  onRowPress,
  renderCard,
  loading = false,
  empty,
  footer,
  rowHeight = 56,
  selectLabel,
  rowLabel,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  label: string;
  selection?: Selection;
  onRowPress?: (row: T) => void;
  renderCard?: (row: T) => ReactNode;
  loading?: boolean;
  /** Shown instead of the rows when there are none. */
  empty?: ReactNode;
  /** Below the rows, inside the frame (pagination). */
  footer?: ReactNode;
  rowHeight?: number;
  /** Names a row's checkbox for screen readers ("Select order 1001"). Default: "Select <row key>". */
  selectLabel?: (row: T) => string;
  /** Names a pressable row for screen readers ("Order 1001"). Default: the row's own text. */
  rowLabel?: (row: T) => string;
}) {
  const { colors } = useTheme();
  const t = useT();
  const { breakpoint, isMobile } = useBreakpoint();
  const visible = columns.filter((c) => RANK[breakpoint] >= NEEDS[c.show ?? 'always']);
  const CHECK = 52;
  const minTotal = visible.reduce((n, c) => n + (c.minWidth ?? 120), 0) + (selection ? CHECK : 0);
  const cell = (c: Column<T>) => ({
    flexGrow: c.flex ?? 1,
    flexBasis: c.minWidth ?? 120,
    minWidth: c.minWidth ?? 120,
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    justifyContent: 'center' as const,
    alignItems: c.align === 'right' ? ('flex-end' as const) : ('flex-start' as const),
  });
  const ids = rows.map(rowKey);
  const allSelected =
    !!selection && ids.length > 0 && ids.every((id) => selection.selected.includes(id));
  const toggle = (id: string, on: boolean) =>
    selection?.onChange(
      on ? [...new Set([...selection.selected, id])] : selection.selected.filter((x) => x !== id),
    );
  const frame = {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    overflow: 'hidden' as const,
    backgroundColor: colors.surface,
  };

  if (!loading && rows.length === 0 && empty) return <View style={frame}>{empty}</View>;

  if (isMobile && renderCard) {
    return (
      <View style={{ gap: space[3] }} role="list" aria-label={t(label)}>
        {loading
          ? [0, 1, 2].map((i) => (
              <View key={i} style={[frame, { padding: space[4], gap: space[2] }]}>
                <Skeleton width="40%" />
                <Skeleton width="70%" />
              </View>
            ))
          : rows.map((row) => {
              const id = rowKey(row);
              const on = !!selection?.selected.includes(id);
              return (
                <RowShell
                  key={id}
                  role="listitem"
                  onPress={onRowPress ? () => onRowPress(row) : undefined}
                  label={rowLabel?.(row)}
                  style={[
                    frame,
                    { padding: space[4], flexDirection: 'row', gap: space[3] },
                    on
                      ? { backgroundColor: colors.primarySoft, borderColor: colors.primaryTint }
                      : null,
                  ]}
                >
                  {selection && (
                    <Checkbox
                      checked={on}
                      onChange={(v) => toggle(id, v)}
                      label={selectLabel ? selectLabel(row) : `Select ${id}`}
                      hideLabel
                    />
                  )}
                  <View style={{ flex: 1, minWidth: 0 }}>{renderCard(row)}</View>
                </RowShell>
              );
            })}
        {footer && <View style={frame}>{footer}</View>}
      </View>
    );
  }

  return (
    <View style={frame}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator
        contentContainerStyle={{ flexGrow: 1 }}
        tabIndex={0}
        role="region"
        aria-label={label ? t('{label}, scrollable', { label: t(label) }) : undefined}
      >
        <View role="table" aria-label={t(label)} style={{ minWidth: minTotal, flexGrow: 1 }}>
          <View
            role="row"
            style={{
              flexDirection: 'row',
              backgroundColor: colors.subtle,
              borderBottomWidth: 1,
              borderBottomColor: colors.border,
              minHeight: 40,
            }}
          >
            {selection && (
              <View
                role="columnheader"
                style={{ width: CHECK, justifyContent: 'center', alignItems: 'center' }}
              >
                <Checkbox
                  checked={allSelected}
                  onChange={(v) => selection.onChange(v ? ids : [])}
                  label="Select all rows"
                  hideLabel
                />
              </View>
            )}
            {visible.map((c) => (
              <View key={c.key} role="columnheader" style={cell(c)}>
                <Text
                  variant="fine"
                  style={{
                    textTransform: 'uppercase',
                    letterSpacing: 0.4,
                    color: colors.foreground,
                    opacity: 0.8,
                  }}
                >
                  {c.header}
                </Text>
              </View>
            ))}
          </View>
          {loading
            ? [0, 1, 2, 3].map((i) => (
                <View
                  key={i}
                  role="row"
                  style={{
                    flexDirection: 'row',
                    minHeight: rowHeight,
                    borderBottomWidth: 1,
                    borderBottomColor: colors.border,
                  }}
                >
                  {selection && <View role="cell" style={{ width: CHECK }} />}
                  {visible.map((c) => (
                    <View key={c.key} role="cell" style={cell(c)}>
                      <Skeleton width="70%" />
                    </View>
                  ))}
                </View>
              ))
            : rows.map((row, i) => {
                const id = rowKey(row);
                const on = !!selection?.selected.includes(id);
                const last = i === rows.length - 1 && !footer;
                return (
                  <RowShell
                    key={id}
                    role="row"
                    onPress={onRowPress ? () => onRowPress(row) : undefined}
                    label={rowLabel?.(row)}
                    style={(state) => [
                      {
                        flexDirection: 'row',
                        minHeight: rowHeight,
                        borderBottomWidth: last ? 0 : 1,
                        borderBottomColor: colors.border,
                      },
                      on
                        ? { backgroundColor: colors.primarySoft }
                        : (state as { hovered?: boolean }).hovered && onRowPress
                          ? { backgroundColor: colors.background }
                          : null,
                    ]}
                  >
                    {selection && (
                      <View
                        role="cell"
                        style={{ width: CHECK, justifyContent: 'center', alignItems: 'center' }}
                      >
                        <Checkbox
                          checked={on}
                          onChange={(v) => toggle(id, v)}
                          label={selectLabel ? selectLabel(row) : `Select ${id}`}
                          hideLabel
                        />
                      </View>
                    )}
                    {visible.map((c) => (
                      <View key={c.key} role="cell" style={cell(c)}>
                        {renderCell(c.render(row))}
                      </View>
                    ))}
                  </RowShell>
                );
              })}
        </View>
      </ScrollView>
      {footer && <View style={{ borderTopWidth: 1, borderTopColor: colors.border }}>{footer}</View>}
    </View>
  );
}
