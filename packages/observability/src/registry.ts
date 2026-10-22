/**
 * A small Prometheus text-format registry (exposition format 0.0.4): counters, gauges and histograms with a bounded number
 * of label combinations. Written in-house on purpose: the usual client library is deprecated, and what OrderLoop needs fits
 * in one file with nothing to audit but this.
 *
 * Safety rules enforced here, not left to callers:
 *  - label NAMES are fixed when a metric is created;
 *  - label VALUES are truncated and stripped of control characters;
 *  - a metric accepts at most `maxSeries` label combinations; further new ones are dropped and counted in
 *    `orderloop_metrics_dropped_series_total`, so a bug that puts an id into a label cannot grow memory without bound.
 */

export type Labels = Record<string, string>;

const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_VALUE_LENGTH = 80;
export const DEFAULT_MAX_SERIES = 200;

/** Prometheus label-value escaping, after dropping control characters and truncating. */
export function cleanLabelValue(value: string): string {
  const v = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, MAX_VALUE_LENGTH);
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function formatNumber(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return '+Inf';
  if (n === -Infinity) return '-Inf';
  return String(n);
}

function escapeHelp(help: string): string {
  return help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

abstract class Metric {
  protected readonly series = new Map<string, { labels: string[]; value: number }>();

  constructor(
    protected readonly registry: Registry,
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[],
    protected readonly maxSeries: number,
    readonly type: 'counter' | 'gauge' | 'histogram',
  ) {
    if (!NAME_RE.test(name)) throw new Error(`invalid metric name: ${name}`);
    for (const l of labelNames) if (!LABEL_RE.test(l)) throw new Error(`invalid label name: ${l}`);
  }

  /** Label values in the order of `labelNames`; a missing one is the empty string. */
  protected key(labels: Labels): string[] {
    return this.labelNames.map((n) => cleanLabelValue(labels[n] ?? ''));
  }

  protected slot(labels: Labels): { labels: string[]; value: number } | undefined {
    const values = this.key(labels);
    const k = values.join('\u0001');
    let s = this.series.get(k);
    if (!s) {
      if (this.series.size >= this.maxSeries) {
        this.registry.noteDropped(this.name);
        return undefined;
      }
      s = { labels: values, value: 0 };
      this.series.set(k, s);
    }
    return s;
  }

  protected render(names: readonly string[], values: readonly string[]): string {
    if (names.length === 0) return '';
    return `{${names.map((n, i) => `${n}="${values[i] ?? ''}"`).join(',')}}`;
  }

  /** Number of label combinations currently held (for tests and the dropped-series guard). */
  get size(): number {
    return this.series.size;
  }

  abstract lines(): string[];

  header(): string[] {
    return [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} ${this.type}`];
  }
}

export class Counter extends Metric {
  inc(labels: Labels = {}, by = 1): void {
    if (by < 0 || !Number.isFinite(by)) return;
    const s = this.slot(labels);
    if (s) s.value += by;
  }
  lines(): string[] {
    const out = this.header();
    for (const s of this.series.values())
      out.push(`${this.name}${this.render(this.labelNames, s.labels)} ${formatNumber(s.value)}`);
    return out;
  }
}

export class Gauge extends Metric {
  /** Replaces every series at scrape time: for values recomputed on each scrape (queue depth, ages, cumulative process CPU). */
  private collector: ((g: Gauge) => void | Promise<void>) | undefined;
  set(labels: Labels, value: number): void {
    const s = this.slot(labels);
    if (s) s.value = value;
  }
  setCollector(fn: (g: Gauge) => void | Promise<void>): void {
    this.collector = fn;
  }
  reset(): void {
    this.series.clear();
  }
  async collect(): Promise<void> {
    if (!this.collector) return;
    this.reset();
    await this.collector(this);
  }
  lines(): string[] {
    const out = this.header();
    for (const s of this.series.values())
      out.push(`${this.name}${this.render(this.labelNames, s.labels)} ${formatNumber(s.value)}`);
    return out;
  }
}

export class Histogram extends Metric {
  private readonly hist = new Map<string, { labels: string[]; counts: number[]; sum: number }>();
  constructor(
    registry: Registry,
    name: string,
    help: string,
    labelNames: readonly string[],
    maxSeries: number,
    readonly buckets: readonly number[],
  ) {
    super(registry, name, help, labelNames, maxSeries, 'histogram');
    if (labelNames.includes('le')) throw new Error('"le" is reserved for histogram buckets');
  }
  observe(labels: Labels, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    const values = this.key(labels);
    const k = values.join('\u0001');
    let h = this.hist.get(k);
    if (!h) {
      if (this.hist.size >= this.maxSeries) {
        this.registry.noteDropped(this.name);
        return;
      }
      h = { labels: values, counts: new Array<number>(this.buckets.length + 1).fill(0), sum: 0 };
      this.hist.set(k, h);
    }
    let i = this.buckets.findIndex((b) => value <= b);
    if (i === -1) i = this.buckets.length;
    h.counts[i] = (h.counts[i] ?? 0) + 1;
    h.sum += value;
  }
  override get size(): number {
    return this.hist.size;
  }
  lines(): string[] {
    const out = this.header();
    for (const h of this.hist.values()) {
      let cumulative = 0;
      this.buckets.forEach((b, i) => {
        cumulative += h.counts[i] ?? 0;
        out.push(
          `${this.name}_bucket${this.render([...this.labelNames, 'le'], [...h.labels, String(b)])} ${cumulative}`,
        );
      });
      cumulative += h.counts[this.buckets.length] ?? 0;
      out.push(
        `${this.name}_bucket${this.render([...this.labelNames, 'le'], [...h.labels, '+Inf'])} ${cumulative}`,
      );
      out.push(`${this.name}_sum${this.render(this.labelNames, h.labels)} ${formatNumber(h.sum)}`);
      out.push(`${this.name}_count${this.render(this.labelNames, h.labels)} ${cumulative}`);
    }
    return out;
  }
}

export interface MetricOptions {
  name: string;
  help: string;
  labelNames?: readonly string[];
  /** Cap on label combinations (default 200). */
  maxSeries?: number;
}

export class Registry {
  private readonly metrics = new Map<string, Metric>();
  private readonly dropped: Counter;

  constructor() {
    this.dropped = this.counter({
      name: 'orderloop_metrics_dropped_series_total',
      help: 'New label combinations refused because a metric reached its series cap',
      labelNames: ['metric'],
      maxSeries: 100,
    });
  }

  /** @internal */
  noteDropped(metric: string): void {
    // Never recurse: if the dropped counter itself overflows its own cap, the increment is a no-op.
    this.dropped.inc({ metric });
  }

  private add<T extends Metric>(m: T): T {
    if (this.metrics.has(m.name)) throw new Error(`metric already registered: ${m.name}`);
    this.metrics.set(m.name, m);
    return m;
  }

  counter(o: MetricOptions): Counter {
    return this.add(
      new Counter(
        this,
        o.name,
        o.help,
        o.labelNames ?? [],
        o.maxSeries ?? DEFAULT_MAX_SERIES,
        'counter',
      ),
    );
  }

  gauge(o: MetricOptions): Gauge {
    return this.add(
      new Gauge(
        this,
        o.name,
        o.help,
        o.labelNames ?? [],
        o.maxSeries ?? DEFAULT_MAX_SERIES,
        'gauge',
      ),
    );
  }

  /** A scrape-time value that only ever grows (CPU seconds), exposed with TYPE counter. */
  collectedCounter(o: MetricOptions): Gauge {
    return this.add(
      new Gauge(
        this,
        o.name,
        o.help,
        o.labelNames ?? [],
        o.maxSeries ?? DEFAULT_MAX_SERIES,
        'counter',
      ),
    );
  }

  histogram(o: MetricOptions & { buckets: readonly number[] }): Histogram {
    return this.add(
      new Histogram(
        this,
        o.name,
        o.help,
        o.labelNames ?? [],
        o.maxSeries ?? DEFAULT_MAX_SERIES,
        o.buckets,
      ),
    );
  }

  /** Runs every gauge collector (a failing one is skipped: a scrape must not fail because one source is down) and renders the text format. */
  async render(): Promise<string> {
    for (const m of this.metrics.values())
      if (m instanceof Gauge)
        try {
          await m.collect();
        } catch {
          m.reset();
        }
    const lines: string[] = [];
    for (const m of this.metrics.values()) lines.push(...m.lines());
    return `${lines.join('\n')}\n`;
  }

  get contentType(): string {
    return 'text/plain; version=0.0.4; charset=utf-8';
  }
}
