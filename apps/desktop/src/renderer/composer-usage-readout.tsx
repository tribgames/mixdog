import { createLucideIcon, DatabaseZap, Gauge, type LucideIcon } from 'lucide-react';
import {
  createContext,
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { Snapshot } from './desktop-types';
import { t } from './i18n';
import { useSurfaceActive } from './surface-activity';
import { asRecord } from './text-format';
import { usageMoney } from './usage-format';

/** Layout placement token provided by enclosing rows (e.g. ComposerModelLine) so
 *  FittedReadout re-fits synchronously in useLayoutEffect when card/row mode flips. */
export const ReadoutLayoutContext = createContext<string>('');

interface SessionUsageTotals {
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

const MIN_LIVE_MS = 1500;
const MIN_LIVE_TOKENS = 50;

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
type ReadoutIcon = LucideIcon | 'dot' | null;

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
  /** The widest `text` / `word` a changing value takes: the line's form is
   *  chosen against these, so a value ticking by never flips it. */
  fit?: { text: string; word: string };
}

interface ReadoutParts {
  total: ReadoutItem | null;
  speed: ReadoutItem | null;
  hit: ReadoutItem | null;
}

/** 97.8%: a cache-hit share as the readout shows it. */
export function formatHitPercent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

/** One coin, face on: tokens. */
const Coin = createLucideIcon('coin', [
  ['circle', { cx: '12', cy: '12', r: '9', key: 'rim' }],
  ['path', { d: 'M10.5 9H12v6', key: 'one' }],
  ['path', { d: 'M10.5 15h3', key: 'foot' }],
]);

/** The token-total item (`730.5M tokens`) for an already formatted value;
 *  the composer agents panel's footer shows its total through it too. */
export function tokensReadoutItem(tokens: string): ReadoutItem {
  return {
    icon: Coin,
    text: tokens,
    label: t('Total tokens {{tokens}}', { tokens }),
    word: t('Total {{tokens}} tokens', { tokens, defaultValue: '{{tokens}} tokens' }),
  };
}

/** The cache-hit item (`Cache hit 97.8%`) for an already formatted value. */
export function cacheHitReadoutItem(percent: string): ReadoutItem {
  return {
    icon: DatabaseZap,
    text: percent,
    label: t('Cache hit {{percent}}', { percent }),
    word: t('Cache hit {{percent}}', { percent }),
  };
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
  // The session average and a streaming call's `~` rate share one widest
  // value, so the line keeps its form when a turn starts and ends.
  const widestSpeed = `~${'0'.repeat(Math.max(3, speedValue.replace('~', '').length))}`;
  return {
    total: total === null ? null : tokensReadoutItem(formatCompactTokens(total)),
    speed: speedValue
      ? {
          icon: Gauge,
          text: `${speedValue}/s`,
          label: t('Output speed {{speed}}', { speed: `${speedValue} tok/s` }),
          word: `${speedValue} tok/s`,
          fit: { text: `${widestSpeed}/s`, word: `${widestSpeed} tok/s` },
        }
      : null,
    hit: hit === null ? null : cacheHitReadoutItem(formatHitPercent(hit)),
  };
}

/** Parts by how long they survive a narrowing line: tok/s last. */
const KEEP_ORDER = ['speed', 'total', 'hit'];
const DISPLAY_ORDER = ['total', 'speed', 'hit'];

/** The estimated-cost item for an already formatted amount (`$6,216.60`); its `$` marks it, so it carries no icon. */
export function costReadoutItem(cost: string): ReadoutItem {
  const label = t('Island: {{cost}} est. cost', { cost });
  return { icon: null, text: cost, label, word: label };
}

/** The session panel's Usage row: the usage readout's worded line, always
 *  with its cache hit (0.0% until a cache read lands), and the session's
 *  estimated cost after it where the row has the room. The cost is the first
 *  to go: the worded line without it comes before any icon form. */
export function usageWithCostVariants(snapshot: Snapshot): ReadoutItem[][] {
  const parts = usageReadoutParts(sessionUsageTotals(snapshot.stats), liveTokensPerSecond(snapshot.spinner));
  if (parts.total && !parts.hit) parts.hit = cacheHitReadoutItem(formatHitPercent(0));
  const variants = readoutVariants(parts);
  const usd = Number(asRecord(snapshot.stats)?.costUsd);
  if (!variants.length || !Number.isFinite(usd) || usd <= 0) return variants;
  const cost = costReadoutItem(usageMoney(usd));
  const [worded, icons, ...fewer] = variants;
  return [
    [
      ...worded.slice(0, -1),
      { ...worded[worded.length - 1], separator: true },
      // The amount alone: its tooltip names it.
      cost,
    ],
    worded,
    [...icons, cost],
    icons,
    ...fewer,
  ];
}

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
    fit: item.fit && { text: item.fit.word, word: item.fit.word },
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
let measureFont = '';
/** Canvas text width. Assigning `font` parses the shorthand every time, even
 *  to the value it holds: set once per font, not once per string. */
function measureTextWidth(font: string, text: string): number {
  if (measureContext === undefined) measureContext = document.createElement('canvas').getContext('2d');
  if (!measureContext) return 0;
  if (measureFont !== font) {
    measureContext.font = font;
    measureFont = font;
  }
  return measureContext.measureText(text).width;
}

/** A text width measurer that remembers each text's width; a new font starts it over. */
export function textWidths(): (font: string, text: string) => number {
  const widths = new Map<string, number>();
  let widthsFont = '';
  return (font, text) => {
    if (font !== widthsFont) {
      widths.clear();
      widthsFont = font;
    }
    let width = widths.get(text);
    if (width === undefined) {
      width = measureTextWidth(font, text);
      widths.set(text, width);
    }
    return width;
  };
}

const fitText = (item: ReadoutItem) => item.fit?.text ?? item.text;

function ReadoutMark({ icon: Icon }: { icon: ReadoutItem['icon'] }) {
  if (Icon === 'dot') return <span className="composer-readout-dot" aria-hidden="true" />;
  return Icon ? <Icon size={ICON_WIDTH} aria-hidden="true" /> : null;
}

function ReadoutItems({ items }: { items: ReadoutItem[] }): ReactNode {
  return items.map((item) => (
    <span key={item.label} className="composer-readout-item" role="img" title={item.label} aria-label={item.label}>
      <ReadoutMark icon={item.icon} />
      {item.text}
      {item.separator ? (
        <span className="composer-readout-sep" aria-hidden="true">
          ·
        </span>
      ) : null}
    </span>
  ));
}

/** A muted line of icon + value items with no hover card. On a narrow line it
 *  drops items in the variants' order instead of ellipsizing; the readouts
 *  (usage, routines, the agents panel's footer) fit through here. Without
 *  `onClick` it is a plain group named by `title`, not a button. */
export function FittedReadout({
  variants,
  onClick,
  title,
  className = '',
  gap = ITEM_GAP,
  layoutKey,
}: {
  variants: ReadoutItem[][];
  onClick?(): void;
  title: string;
  className?: string;
  /** The room between items and around a `·`, in px (--readout-gap): a word space where the line is read as text. */
  gap?: number;
  /** Explicit placement or visibility key that forces a synchronous re-fit before paint. */
  layoutKey?: unknown;
}) {
  const ref = useRef<HTMLElement>(null);
  const textCacheRef = useRef<{ key: string; measure: ReturnType<typeof textWidths> } | null>(null);
  const [shown, setShown] = useState(0);
  const surfaceActive = useSurfaceActive();
  const contextLayoutKey = useContext(ReadoutLayoutContext);
  const key = variants
    .map((items) => items.map((item) => `${item.icon ? 1 : 0}${fitText(item)}`).join('\t'))
    .join('\n');
  // biome-ignore lint/correctness/useExhaustiveDependencies: the variants' texts, row placement and visibility key re-measurement
  useLayoutEffect(() => {
    const button = ref.current;
    const line = button?.parentElement;
    if (!button || !line) {
      // Clear cached widths while absent (e.g. empty variants): its font-load
      // listener is disconnected, so returning with the same texts must re-measure.
      textCacheRef.current = null;
      return undefined;
    }
    // Reuse cached measurements across layout/placement re-fits of the same
    // variant texts, but replace the cache when the texts themselves change
    // so historical token/cost strings are not retained.
    if (textCacheRef.current?.key !== key) textCacheRef.current = { key, measure: textWidths() };
    const measure = () => {
      const textWidth = textCacheRef.current?.measure ?? textWidths();
      if (!textCacheRef.current) textCacheRef.current = { key, measure: textWidth };
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
        textWidth(font, fitText(item)) +
        (item.separator ? gap + textWidth(font, '·') : 0) +
        (item.icon === 'dot' ? DOT_WIDTH + ICON_GAP : item.icon ? ICON_WIDTH + ICON_GAP : 0);
      // The `font` shorthand reads back empty when the element sets other
      // font properties (numeric variants), so the canvas gets its parts.
      const widths = variants.map(
        (items) => items.reduce((sum, item) => sum + itemWidth(item), 0) + gap * (items.length - 1) + padding + 2
      );
      // The worded form (variant 0): what the PC's one-line layout needs
      // before the card takes over (useOneLineOverflow).
      button.dataset.fullWidth = String(Math.ceil(widths[0] ?? 0) + 8);
      // The room kept between the line and what stands beside it: 8px, or the row's own gap where it is wider (the
      // island panels' foot), so the fitted line and its neighbours share the row.
      const beside = others > 0 ? Math.max(8, Number.parseFloat(lineStyle.columnGap) || 0) : 8;
      setShown(fittingVariant(widths, available - beside));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(line);
    const observeSiblings = () => {
      for (const child of Array.from(line.children)) if (child !== button) observer.observe(child);
    };
    observeSiblings();
    // A sibling that appears later (the route label, once its setting is on or
    // the delegation mode arrives) takes room too, though nothing resized yet.
    const siblings = new MutationObserver(() => {
      observeSiblings();
      measure();
    });
    siblings.observe(line, { childList: true });
    // A web font that finishes loading changes the texts' widths, though
    // neither the line nor its items may resize for it: measure afresh.
    const onFontsLoaded = () => {
      textCacheRef.current = { key, measure: textWidths() };
      measure();
    };
    document.fonts?.addEventListener('loadingdone', onFontsLoaded);
    return () => {
      observer.disconnect();
      siblings.disconnect();
      document.fonts?.removeEventListener('loadingdone', onFontsLoaded);
    };
  }, [key, gap, surfaceActive, contextLayoutKey, layoutKey]);
  if (!variants.length) return null;
  const index = shown < 0 ? -1 : Math.min(shown, variants.length - 1);
  const classes = `composer-usage-readout ${className}`.trim();
  const style = gap === ITEM_GAP ? undefined : ({ '--readout-gap': `${gap}px` } as CSSProperties);
  const items = <ReadoutItems items={variants[Math.max(index, 0)]} />;
  if (!onClick) {
    return (
      // biome-ignore lint/a11y/useSemanticElements: fieldset default border/padding/margin would change the line.
      <span
        ref={ref as RefObject<HTMLSpanElement>}
        className={classes}
        style={style}
        role="group"
        aria-label={title}
        hidden={index < 0}
      >
        {items}
      </span>
    );
  }
  return (
    <button
      ref={ref as RefObject<HTMLButtonElement>}
      type="button"
      className={classes}
      style={style}
      hidden={index < 0}
      onClick={onClick}
      title={title}
    >
      {items}
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
