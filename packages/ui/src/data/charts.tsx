import { useEffect, useId, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, Stop } from '../theme/svg';
import { useT } from '../i18n';
import { Text } from '../Text';
import { useTheme } from '../theme/theme';
import { chartColors, radius, space } from '../theme/tokens';

export interface Series {
  key: string;
  label: string;
  values: (number | null)[];
  color?: string;
  /** Fill the area under the line (the main series). */
  area?: boolean;
}

/** Round a maximum up to a tidy axis ceiling (1, 2, 2.5, 5 or 10 × a power of ten). */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(max));
  const n = max / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * pow;
}

/**
 * A line and area chart over a few labelled points (one per day). Hover or touch a day to read its values in a tooltip. A
 * visually hidden table repeats the data for screen readers. A series value of `null` is a gap (unknown), not zero.
 */
export function AreaChart({
  labels,
  series,
  format,
  formatAxis,
  height = 220,
  title,
  tooltipTitle,
}: {
  labels: string[];
  series: Series[];
  format: (value: number) => string;
  /** Short axis labels (৳50k). Defaults to `format`. */
  formatAxis?: (value: number) => string;
  height?: number;
  title: string;
  /** Long label for the tooltip's first line (Sat, 17 Oct). */
  tooltipTitle?: (index: number) => string;
}) {
  const { colors } = useTheme();
  const t = useT();
  const id = useId().replace(/:/g, '');
  const [width, setWidth] = useState(560);
  const [active, setActive] = useState<number | null>(null);
  // The tooltip lingers 1.5 s after a touch. One timer, replaced by the next touch and cleared when the chart goes away,
  // so an earlier tap can never hide the tooltip of a later one.
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelHide = () => clearTimeout(hideTimer.current);
  const hideSoon = () => {
    cancelHide();
    hideTimer.current = setTimeout(() => setActive(null), 1500);
  };
  useEffect(() => cancelHide, []);
  const PAD = { left: 48, right: 26, top: 12, bottom: 28 };
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const max = niceMax(Math.max(0, ...all));
  const ticks = [0, 1, 2, 3, 4].map((i) => (max / 4) * i);
  const n = labels.length;
  const innerW = Math.max(10, width - PAD.left - PAD.right);
  const innerH = height - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (n <= 1 ? innerW / 2 : (innerW * i) / (n - 1));
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const paths = series.map((s, si) => {
    const color = s.color ?? chartColors[si % chartColors.length]!;
    let d = '';
    let run = false;
    s.values.forEach((v, i) => {
      if (v === null) {
        run = false;
        return;
      }
      d += `${run ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
      run = true;
    });
    const complete = s.values.every((v) => v !== null);
    const area =
      s.area && complete && n > 1
        ? `${d}L${x(n - 1).toFixed(1)} ${y(0).toFixed(1)} L${x(0).toFixed(1)} ${y(0).toFixed(1)} Z`
        : null;
    return { s, color, d, area };
  });
  const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(innerW / 56))));
  return (
    <View style={{ gap: space[2] }}>
      <View style={{ flexDirection: 'row', gap: space[4], flexWrap: 'wrap' }}>
        {paths.map((p) => (
          <View
            key={p.s.key}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '100%' }}
          >
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: p.color,
                flexShrink: 0,
              }}
            />
            <Text variant="small" tone="muted" style={{ flexShrink: 1 }}>
              {p.s.label}
            </Text>
          </View>
        ))}
      </View>
      <View
        // Clipped, so the svg's own width can never hold the box open: the box follows its parent and the svg follows the box.
        style={{ height, width: '100%', minWidth: 0, overflow: 'hidden' }}
        onLayout={(e) => setWidth(Math.max(1, Math.floor(e.nativeEvent.layout.width)))}
      >
        <Svg width={width} height={height} role="img" aria-label={t(title)}>
          <Defs>
            <LinearGradient id={`g${id}`} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={paths[0]?.color ?? colors.primary} stopOpacity={0.18} />
              <Stop offset="1" stopColor={paths[0]?.color ?? colors.primary} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          {ticks.map((tick, i) => (
            <G key={i}>
              <Line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(tick)}
                y2={y(tick)}
                stroke={colors.border}
                strokeWidth={1}
                strokeDasharray={i === 0 ? undefined : '3 4'}
              />
            </G>
          ))}
          {paths.map((p) => (
            <G key={p.s.key}>
              {p.area && <Path d={p.area} fill={`url(#g${id})`} />}
              <Path
                d={p.d}
                stroke={p.color}
                strokeWidth={2}
                fill="none"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </G>
          ))}
          {active !== null && (
            <G>
              <Line
                x1={x(active)}
                x2={x(active)}
                y1={PAD.top}
                y2={PAD.top + innerH}
                stroke={colors.borderStrong}
                strokeWidth={1}
              />
              {paths.map((p) => {
                const v = p.s.values[active];
                return v === null || v === undefined ? null : (
                  <Circle
                    key={p.s.key}
                    cx={x(active)}
                    cy={y(v)}
                    r={4}
                    fill={colors.surface}
                    stroke={p.color}
                    strokeWidth={2}
                  />
                );
              })}
            </G>
          )}
        </Svg>
        {ticks.map((tick, i) => (
          <Text
            key={i}
            variant="caption"
            tone="muted"
            numeric
            style={{
              position: 'absolute',
              left: 0,
              width: PAD.left - 8,
              textAlign: 'right',
              top: y(tick) - 8,
            }}
          >
            {(formatAxis ?? format)(tick)}
          </Text>
        ))}
        {labels.map((l, i) =>
          i % step === 0 || i === n - 1 ? (
            <Text
              key={i}
              variant="caption"
              tone="muted"
              style={{
                position: 'absolute',
                top: height - PAD.bottom + 8,
                left: x(i) - 24,
                width: 48,
                textAlign: 'center',
              }}
            >
              {l}
            </Text>
          ) : null,
        )}
        {/* Hit areas: one column per point. */}
        <View
          style={{
            position: 'absolute',
            left: PAD.left - (n > 1 ? innerW / (n - 1) / 2 : 0),
            top: PAD.top,
            width: innerW + (n > 1 ? innerW / (n - 1) : 0),
            height: innerH,
            flexDirection: 'row',
          }}
        >
          {labels.map((l, i) => (
            <Pressable
              key={i}
              accessible={false}
              focusable={false}
              onHoverIn={() => setActive(i)}
              onHoverOut={() => setActive(null)}
              onPressIn={() => {
                cancelHide();
                setActive(i);
              }}
              onPressOut={hideSoon}
              style={{ flex: 1 }}
            />
          ))}
        </View>
        {active !== null && (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: 4,
              left: Math.min(Math.max(x(active) - 80, 0), Math.max(0, width - 168)),
              width: 160,
              backgroundColor: '#0f172a',
              borderRadius: radius.md,
              padding: space[2],
              gap: 2,
            }}
          >
            <Text variant="caption" style={{ color: '#cbd5e1' }}>
              {tooltipTitle ? tooltipTitle(active) : labels[active]}
            </Text>
            {series.map((s) => (
              <Text key={s.key} variant="fine" numeric style={{ color: '#fff' }}>
                {`${s.label} ${s.values[active] === null || s.values[active] === undefined ? 'not known' : format(s.values[active] as number)}`}
              </Text>
            ))}
          </View>
        )}
      </View>
      {/* The same data, for screen readers. */}
      <View
        role="table"
        aria-label={t('{title} (data)', { title: t(title) })}
        style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0 }}
      >
        {labels.map((l, i) => (
          <View key={i} role="row">
            <Text role="cell">{l}</Text>
            {series.map((s) => (
              <Text
                key={s.key}
                role="cell"
              >{`${s.label}: ${s.values[i] === null || s.values[i] === undefined ? 'not known' : format(s.values[i] as number)}`}</Text>
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

export interface DonutSlice {
  key: string;
  label: string;
  value: number;
  color?: string;
}

/** A ring split into slices, with a number and caption in the middle. The legend is the caller's (it names each slice). */
export function DonutChart({
  slices,
  size = 168,
  thickness = 22,
  centerValue,
  centerLabel,
  title,
}: {
  slices: DonutSlice[];
  size?: number;
  thickness?: number;
  centerValue: string;
  centerLabel: string;
  title: string;
}) {
  const { colors } = useTheme();
  const t = useT();
  const total = slices.reduce((n, s) => n + Math.max(0, s.value), 0);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} role="img" aria-label={t(title)}>
        <G transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <Circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke={colors.subtle}
            strokeWidth={thickness}
            fill="none"
          />
          {total > 0 &&
            slices.map((s, i) => {
              const len = (Math.max(0, s.value) / total) * c;
              const el = (
                <Circle
                  key={s.key}
                  cx={size / 2}
                  cy={size / 2}
                  r={r}
                  stroke={s.color ?? chartColors[i % chartColors.length]}
                  strokeWidth={thickness}
                  fill="none"
                  strokeDasharray={`${Math.max(0, len - 2)} ${c - Math.max(0, len - 2)}`}
                  strokeDashoffset={-offset}
                />
              );
              offset += len;
              return el;
            })}
        </G>
      </Svg>
      <View style={{ position: 'absolute', alignItems: 'center' }}>
        <Text variant="metric" numeric>
          {centerValue}
        </Text>
        <Text variant="caption" tone="muted">
          {centerLabel}
        </Text>
      </View>
    </View>
  );
}

export interface WaterfallStep {
  key: string;
  label: string;
  /** The amount; the bar's height. */
  value: number;
  /** `total` stands on the floor (a subtotal), `minus` hangs from the running total, `plus` rises from it. */
  kind: 'total' | 'minus' | 'plus';
  color?: string;
}

/**
 * A waterfall: from a starting total, each step takes something off (or adds), ending at a result. Every bar is labelled with
 * its amount; on a narrow screen the chart scrolls sideways rather than squeezing the bars.
 */
export function WaterfallChart({
  steps,
  format,
  height = 240,
  title,
}: {
  steps: WaterfallStep[];
  format: (value: number) => string;
  height?: number;
  title: string;
}) {
  const { colors } = useTheme();
  const t = useT();
  let running = 0;
  const bars = steps.map((s) => {
    let from: number;
    let to: number;
    if (s.kind === 'total') {
      from = 0;
      to = s.value;
      running = s.value;
    } else if (s.kind === 'minus') {
      from = running - s.value;
      to = running;
      running = from;
    } else {
      from = running;
      to = running + s.value;
      running = to;
    }
    return { s, lo: Math.min(from, to), hi: Math.max(from, to) };
  });
  const max = Math.max(1, ...bars.map((b) => b.hi));
  const min = Math.min(0, ...bars.map((b) => b.lo));
  const span = max - min;
  const plot = height - 56;
  const toY = (v: number) => ((max - v) / span) * plot;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      role="group"
      aria-label={t(title)}
      tabIndex={0}
    >
      <View
        style={{
          minWidth: Math.max(560, steps.length * 84),
          flexDirection: 'row',
          height,
          gap: 8,
          paddingTop: 20,
        }}
      >
        {bars.map((b) => {
          const color =
            b.s.color ??
            (b.s.kind === 'total'
              ? colors.primary
              : b.s.kind === 'minus'
                ? '#f43f5e'
                : colors.accent);
          const top = toY(b.hi);
          const h = Math.max(3, toY(b.lo) - top);
          return (
            <View key={b.s.key} style={{ flex: 1, alignItems: 'center' }}>
              <View style={{ height: plot, width: '100%', alignItems: 'center' }}>
                <Text
                  variant="caption"
                  numeric
                  tone="muted"
                  numberOfLines={1}
                  align="center"
                  style={{ position: 'absolute', top: Math.max(-16, top - 18), width: '100%' }}
                >
                  {b.s.kind === 'minus' ? `−${format(b.s.value)}` : format(b.s.value)}
                </Text>
                <View
                  style={{
                    position: 'absolute',
                    top,
                    height: h,
                    width: '70%',
                    maxWidth: 56,
                    borderRadius: 4,
                    backgroundColor: color,
                  }}
                />
              </View>
              <Text variant="caption" tone="muted" align="center" style={{ marginTop: 8 }}>
                {b.s.label}
              </Text>
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}
