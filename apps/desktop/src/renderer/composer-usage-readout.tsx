// The composer line's muted usage readout: the session's total tokens,
// generation speed and cache hit as plain text. The figures are the session
// runtime's own totals (snapshot.stats.usageReadout, persisted on the session
// record and summed over every model call of this session — all turns,
// tool-loop calls included, delegated sub-agents excluded). While a call is
// streaming, the speed is that call's live rate (snapshot.spinner.liveCall)
// instead, marked "~" because its token count is the runtime's estimate until
// the provider reports the exact one.
import { Coins, DatabaseZap, Gauge, type LucideIcon } from 'lucide-react';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import type { Snapshot } from './desktop-types';
import { t } from './i18n';
import { asRecord } from './text-format';

export interface SessionUsageTotals {
  /** Fresh prompt tokens, over the calls whose prompt was measured. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** Output of every call; null on a record saved before the sum existed. */
  output: number | null;
  /** Output of the timed calls (positive output and positive duration). */
  speedOutputTokens: number;
  /** Request time of those calls: request start → end of response. */
  speedMs: number;
}

// The figures follow the common convention of local model servers, desktop
// model runners and coding agents' usage footers:
// - speed is the usage dialog's throughput: output tokens (reasoning included,
//   as every provider counts it in output) over the request's wall time, from
//   the request start to the end of the response, the wait for the first
//   token included (the usage ledger's duration_ms). The runtime sums the
//   tokens and the times of every call with positive output and positive
//   duration (the usage ledger's eligibility) before dividing here (summed
//   tokens over summed durations: a duration-weighted rate, not a mean of
//   per-call rates); an untimed call never enters the sums. A record saved before this
//   definition (first token → end, speedOutputTokens/speedMs) is read only
//   until a request-timed call lands.
// - cache hit is the cache-read share of the whole prompt,
//   read / (fresh input + cache read + cache write), summed over the session;
//   it stays hidden until the session has read from the cache at all.
// - the live speed waits until the call has streamed this long and this much:
//   a call's first burst is not a rate, and providers that deliver the reply
//   in one burst would read several times their real speed. Until then the
//   session figure stays.
export const MIN_LIVE_MS = 1500;
export const MIN_LIVE_TOKENS = 50;
// - on a narrow line the readout gives up its parts rather than ellipsizing:
//   cache hit first, then the token total; tok/s goes last, and the whole
//   readout hides when not even that fits.

function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The session's cumulative totals (stats.usageReadout), or null before any call landed. */
export function sessionUsageTotals(stats: unknown): SessionUsageTotals | null {
  const totals = asRecord(asRecord(stats)?.usageReadout);
  if (!totals) return null;
  const requestMs = count(totals.requestMs);
  return {
    input: count(totals.input),
    cacheRead: count(totals.cacheRead),
    cacheWrite: count(totals.cacheWrite),
    output: totals.output == null ? null : count(totals.output),
    speedOutputTokens: requestMs > 0 ? count(totals.requestOutputTokens) : count(totals.speedOutputTokens),
    speedMs: requestMs > 0 ? requestMs : count(totals.speedMs),
  };
}

/** Timed output tokens per second of request time; null with no timed call. */
export function outputTokensPerSecond(totals: SessionUsageTotals | null): number | null {
  if (!totals || totals.speedMs <= 0 || totals.speedOutputTokens <= 0) return null;
  return (totals.speedOutputTokens * 1000) / totals.speedMs;
}

/** Cache read over the whole prompt (input + cache read + cache write); null
 *  until the session has any cache read. */
export function cacheHitShare(totals: SessionUsageTotals | null): number | null {
  if (!totals || totals.cacheRead <= 0) return null;
  return totals.cacheRead / (totals.input + totals.cacheRead + totals.cacheWrite);
}

/** Every token the session has used: fresh input, cache read and write, output.
 *  Null when nothing is recorded, or the record predates the output sum. */
export function totalTokens(totals: SessionUsageTotals | null): number | null {
  if (!totals || totals.output === null) return null;
  const sum = totals.input + totals.cacheRead + totals.cacheWrite + totals.output;
  return sum > 0 ? sum : null;
}

const COMPACT_UNITS = ['', 'k', 'M', 'B', 'T'];

/** 842 · 12.3k · 1.2M: one decimal, none when it would be ".0". */
export function formatCompactTokens(value: number): string {
  const last = COMPACT_UNITS.length - 1;
  let scaled = Math.max(0, value);
  let unit = 0;
  while (scaled >= 1000 && unit < last) {
    scaled /= 1000;
    unit += 1;
  }
  if (unit === 0) return String(Math.round(scaled));
  let rounded = Math.round(scaled * 10) / 10;
  if (rounded >= 1000 && unit < last) {
    // 999,950 rounds to "1000k": it is "1M".
    rounded = 1;
    unit += 1;
  }
  return `${rounded}${COMPACT_UNITS[unit]}`;
}

/** The streaming call's rate (spinner.liveCall: its request's start time, the
 *  runtime's token estimate so far and the time of that sample), or null
 *  between calls and before MIN_LIVE_MS / MIN_LIVE_TOKENS. */
export function liveTokensPerSecond(spinner: unknown): number | null {
  const record = asRecord(spinner);
  if (!record || record.active === false) return null;
  const call = asRecord(record.liveCall);
  if (!call) return null;
  const tokens = count(call.outputTokens);
  const ms = count(call.at) - count(call.startedAt);
  if (tokens < MIN_LIVE_TOKENS || ms < MIN_LIVE_MS) return null;
  return (tokens * 1000) / ms;
}

/** What a readout item draws before its value: a lucide icon, a small red
 *  dot (a failure), or nothing. */
export type ReadoutIcon = LucideIcon | 'dot' | null;

export interface ReadoutItem {
  icon: ReadoutIcon;
  /** The value shown on the line. */
  text: string;
  /** The full words, as the item's tooltip and accessible name. */
  label: string;
  /** The worded form shown while the line has room (`665.8k tokens`). */
  word: string;
  /** Worded form only: a `·` follows, spaced like the gap after it. */
  separator?: boolean;
}

export interface ReadoutParts {
  total: ReadoutItem | null;
  speed: ReadoutItem | null;
  hit: ReadoutItem | null;
}

/** The readout's three items, null where there is no data. `liveSpeed`
 *  replaces the session speed while a call streams. */
export function usageReadoutParts(usage: SessionUsageTotals | null, liveSpeed: number | null = null): ReadoutParts {
  const total = totalTokens(usage);
  const speed = outputTokensPerSecond(usage);
  const hit = cacheHitShare(usage);
  let speedValue = '';
  if (liveSpeed !== null) speedValue = `~${Math.round(liveSpeed)}`;
  else if (speed !== null) speedValue = String(Math.round(speed));
  const tokens = total === null ? '' : formatCompactTokens(total);
  const percent = hit === null ? '' : `${(hit * 100).toFixed(1)}%`;
  return {
    total:
      total === null
        ? null
        : {
            icon: Coins,
            text: tokens,
            label: t('Total tokens {{tokens}}', { tokens }),
            word: t('Total {{tokens}} tokens', { tokens, defaultValue: '{{tokens}} tokens' }),
          },
    speed: speedValue
      ? {
          icon: Gauge,
          text: `${speedValue}/s`,
          label: t('Output speed {{speed}}', { speed: `${speedValue} tok/s` }),
          word: `${speedValue} tok/s`,
        }
      : null,
    hit:
      hit === null
        ? null
        : {
            icon: DatabaseZap,
            text: percent,
            label: t('Cache hit {{percent}}', { percent }),
            word: t('Cache hit {{percent}}', { percent }),
          },
  };
}

/** Parts by how long they survive a narrowing line: tok/s last. */
const KEEP_ORDER = ['speed', 'total', 'hit'];
const DISPLAY_ORDER = ['total', 'speed', 'hit'];

function pickItems(
  parts: Record<string, ReadoutItem | null>,
  keep: number,
  keepOrder: readonly string[],
  displayOrder: readonly string[]
): ReadoutItem[] {
  const kept = new Set(keepOrder.filter((name) => parts[name]).slice(0, keep));
  return displayOrder.filter((name) => kept.has(name)).map((name) => parts[name] as ReadoutItem);
}

/** "15.6k 48/s 92.0%" as plain text, with only the `keep` items that outlast
 *  the rest (all by default); null when nothing is left. */
export function usageReadoutText(
  usage: SessionUsageTotals | null,
  liveSpeed: number | null = null,
  keep = KEEP_ORDER.length
): string | null {
  const items = pickItems(
    usageReadoutParts(usage, liveSpeed) as unknown as Record<string, ReadoutItem | null>,
    keep,
    KEEP_ORDER,
    DISPLAY_ORDER
  );
  return items.map((item) => item.text).join(' ') || null;
}

/** The readout's variants from the fullest to the barest (one item): the
 *  worded form of every part first (`665.8k tokens · 83 tok/s · …`, items
 *  carrying their separator), then the icon form, dropping parts in priority
 *  order. The routine readout passes its own orders. */
export function readoutVariants(
  parts: object,
  keepOrder: readonly string[] = KEEP_ORDER,
  displayOrder: readonly string[] = DISPLAY_ORDER
): ReadoutItem[][] {
  const record = parts as Record<string, ReadoutItem | null>;
  const present = keepOrder.filter((name) => record[name]).length;
  const variants: ReadoutItem[][] = [];
  for (let keep = present; keep >= 1; keep -= 1) variants.push(pickItems(record, keep, keepOrder, displayOrder));
  if (!variants.length) return variants;
  const full = variants[0];
  const worded = full.map((item, index) => ({
    ...item,
    icon: null,
    text: item.word,
    separator: index < full.length - 1,
  }));
  return [worded, ...variants];
}

/** Index of the fullest variant whose width fits `available`, or -1 when none does. */
export function fittingVariant(widths: number[], available: number): number {
  return widths.findIndex((width) => width <= available);
}

// Item geometry shared with .composer-readout-item in 15-composer.css.
const ICON_WIDTH = 12;
const DOT_WIDTH = 6;
const ICON_GAP = 3;
const ITEM_GAP = 8;

let measureContext: CanvasRenderingContext2D | null | undefined;
function textWidth(font: string, text: string): number {
  if (measureContext === undefined) measureContext = document.createElement('canvas').getContext('2d');
  if (!measureContext) return 0;
  measureContext.font = font;
  return measureContext.measureText(text).width;
}

function ReadoutItems({ items }: { items: ReadoutItem[] }): ReactNode {
  return items.map((item) => {
    const Icon = item.icon;
    return (
      <span key={item.label} className="composer-readout-item" role="img" title={item.label} aria-label={item.label}>
        {Icon === 'dot' ? (
          <span className="composer-readout-dot" aria-hidden="true" />
        ) : Icon ? (
          <Icon size={ICON_WIDTH} aria-hidden="true" />
        ) : null}
        {item.text}
        {item.separator ? (
          <span className="composer-readout-sep" aria-hidden="true">
            ·
          </span>
        ) : null}
      </span>
    );
  });
}

/** A muted line of icon + value items with no hover card. On a narrow line it
 *  drops items in the variants' order instead of ellipsizing; both readouts
 *  (usage, routines) fit through here. */
export function FittedReadout({
  variants,
  onClick,
  title,
  className = '',
}: {
  variants: ReadoutItem[][];
  onClick(): void;
  title: string;
  className?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [shown, setShown] = useState(0);
  const key = variants.map((items) => items.map((item) => `${item.icon ? 1 : 0}${item.text}`).join('\t')).join('\n');
  // biome-ignore lint/correctness/useExhaustiveDependencies: the variants' texts are the key
  useLayoutEffect(() => {
    const button = ref.current;
    const line = button?.parentElement;
    if (!button || !line) return undefined;
    const measure = () => {
      const lineStyle = getComputedStyle(line);
      const style = getComputedStyle(button);
      // The others at their own width, not the one the readout squeezed them
      // to: layout is synchronous, so nothing paints while it is out.
      const wasHidden = button.hidden;
      button.hidden = true;
      let others = 0;
      for (const child of Array.from(line.children)) {
        if (child !== button) others += child.getBoundingClientRect().width;
      }
      button.hidden = wasHidden;
      const available =
        line.clientWidth -
        Number.parseFloat(lineStyle.paddingLeft) -
        Number.parseFloat(lineStyle.paddingRight) -
        others;
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      const itemWidth = (item: ReadoutItem) =>
        textWidth(font, item.text) +
        (item.separator ? ITEM_GAP + textWidth(font, '·') : 0) +
        (item.icon === 'dot' ? DOT_WIDTH + ICON_GAP : item.icon ? ICON_WIDTH + ICON_GAP : 0);
      setShown(
        fittingVariant(
          // The `font` shorthand reads back empty when the element sets other
          // font properties (numeric variants), so the canvas gets its parts.
          variants.map(
            (items) =>
              items.reduce((sum, item) => sum + itemWidth(item), 0) + ITEM_GAP * (items.length - 1) + padding + 2
          ),
          available - 8
        )
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(line);
    for (const child of Array.from(line.children)) if (child !== button) observer.observe(child);
    return () => observer.disconnect();
  }, [key]);
  if (!variants.length) return null;
  const index = shown < 0 ? -1 : Math.min(shown, variants.length - 1);
  return (
    <button
      ref={ref}
      type="button"
      className={`composer-usage-readout ${className}`.trim()}
      hidden={index < 0}
      onClick={onClick}
      title={title}
    >
      <ReadoutItems items={variants[Math.max(index, 0)]} />
    </button>
  );
}

/** Muted icon + value items; a click opens the Usage view. */
export function ComposerUsageReadout({ snapshot, onOpenUsage }: { snapshot: Snapshot; onOpenUsage(): void }) {
  const variants = readoutVariants(
    usageReadoutParts(sessionUsageTotals(snapshot.stats), liveTokensPerSecond(snapshot.spinner))
  );
  return <FittedReadout variants={variants} onClick={onOpenUsage} title={t('Open usage')} />;
}
