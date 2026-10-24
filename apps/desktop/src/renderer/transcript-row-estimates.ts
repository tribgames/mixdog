import type { TranscriptItem } from './desktop-types';
import type { TranscriptRowModel } from './transcript-rows';
import { TRANSCRIPT_ROW_ESTIMATE } from './transcript-virtual-cache';

/**
 * Size estimates for rows the timeline has not measured yet.
 *
 * A row mounted at a wrong estimate is corrected when it is measured. Above the
 * reader that correction is a scroll write (the content in view must not move),
 * and a scroll write during a touch fling or wheel ramp is felt as a hitch:
 * a first pass up a phone transcript wrote scrollTop ~18 times (+204/-22 px,
 * the 60 px flat estimate against 264 px replies and 38 px tool groups).
 *
 * Two sources replace the flat estimate, best first:
 * - the row's own last measured height at this width, remembered across
 *   sessions, page loads and older-page landings;
 * - the median measured height of rows of the same SHAPE (tag + coarse content
 *   features) at this width. Transcripts repeat their shapes, so a session's
 *   own first rows teach the estimate for the rest of its history.
 *
 * Heights depend on width, so both are keyed by the timeline's width — and on
 * the surface painting the row: an agent chat frames replies as bubbles and
 * paints nothing for most tool rounds (0px), so the two learn apart.
 */

/** What paints the rows: a coding transcript, a bot's chat, or a group room
 *  (member speeches, a band that is empty between member turns). */
export type TranscriptRowSurface = 'coding' | 'agent' | 'room';

// Bumped when the transcript's typography changes: heights measured under
// the old type no longer match (v2: 16px reading body, new markdown spacing).
const STORAGE_KEY = 'mixdog.transcript-row-heights.v2';
const KEY_LIMIT = 2_000;
const SHAPE_SAMPLES = 24;
const SHAPE_LIMIT = 400;
const SHAPE_WIDTH_STEP = 32;
const SAVE_DELAY_MS = 2_000;

interface StoredHeights {
  keys: [string, number][];
  shapes: [string, number[]][];
}

function lengthBucket(text: string): number {
  // 0, 1-31, 32-63, 64-127, … : wraps grow with length, coarsely.
  return text.length === 0 ? 0 : Math.min(14, Math.floor(Math.log2(text.length)) - 3);
}

function textOf(item: TranscriptItem | undefined): string {
  return typeof item?.text === 'string' ? item.text : '';
}

/** Markdown block features that change a reply's height beyond its length. */
function markdownFeatures(text: string): string {
  const fences = (text.match(/^\s*(```|~~~)/gm)?.length ?? 0) >> 1;
  const tableRows = text.match(/^\s*\|.*\|\s*$/gm)?.length ?? 0;
  const listItems = text.match(/^\s*(?:[-*+]|\d+[.)])\s+/gm)?.length ?? 0;
  const headings = text.match(/^\s*#{1,6}\s/gm)?.length ?? 0;
  const paragraphs = text.split(/\n\s*\n/).filter((part) => part.trim()).length;
  const bucket = (count: number) => {
    if (count === 0) return 0;
    if (count < 3) return 1;
    return count < 8 ? 2 : 3;
  };
  return `${Math.min(fences, 3)}${bucket(tableRows)}${bucket(listItems)}${bucket(headings)}${bucket(paragraphs)}`;
}

/** Coarse content signature: rows with one shape render to similar heights. */
export function transcriptRowShape(row: TranscriptRowModel): string {
  switch (row._tag) {
    case 'TurnGap':
    case 'Thinking':
      return row._tag;
    case 'UserMessage': {
      const text = textOf(row.item);
      const lines = Math.min(8, text.split('\n').length);
      // A steer line (waiting, sending or read) adds one fixed-height line.
      const steerLine = row.item?.steer || row.item?.steered === true ? 1 : 0;
      return `user:${lengthBucket(text)}:${lines}:${row.attachedUser ? 1 : 0}:${steerLine}`;
    }
    case 'AssistantPart': {
      const text = textOf(row.item);
      // A room's typing bubble, quiet pass and speech are all empty-or-short
      // notices of very different heights: one shape would blend them.
      return `reply:${row.item?.kind ?? ''}${row.item?.room?.kind ? `/${row.item.room.kind}` : ''}:${lengthBucket(text)}:${markdownFeatures(text)}:${row.completion ? 1 : 0}:${row.turnChanges ? 1 : 0}`;
    }
    case 'ToolActivity': {
      const count = row.items.length;
      const kinds = [...new Set(row.items.map((item) => item?.kind ?? ''))].sort().join('+');
      return `tool:${kinds}:${count > 8 ? 9 : count}`;
    }
    case 'Error':
      return `error:${row.failures.length > 1 ? 2 : 1}:${row.turnChanges ? 1 : 0}`;
  }
}

/** Keys derived from an item id survive reloads; positional keys do not. */
function persistentKey(row: TranscriptRowModel): boolean {
  if (row._tag === 'UserMessage' || row._tag === 'AssistantPart')
    return row.item?.id !== undefined && row.item?.id !== null;
  if (row._tag === 'ToolActivity') return row.items.some((item) => item?.id !== undefined && item?.id !== null);
  return row._tag === 'TurnGap';
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] ?? TRANSCRIPT_ROW_ESTIMATE;
}

/** Every call takes an optional `variant`: what the row paints in its current
 *  context beyond its own content (an agent chat's tool round: how many lines
 *  it draws, transcript-list-estimates.ts). Rows learn and are remembered per
 *  variant, so a row whose variant changed is not estimated from its old height. */
export interface TranscriptRowHeightStore {
  /** Best known height for an unmeasured row at this width. */
  estimate(
    row: TranscriptRowModel | undefined,
    width: number,
    surface?: TranscriptRowSurface,
    variant?: string
  ): number;
  /** Whether `estimate` would return a learned height, not the flat fallback. */
  knows(row: TranscriptRowModel | undefined, width: number, surface?: TranscriptRowSurface, variant?: string): boolean;
  /** A settled measured height of `row` at this width (0 for a row that paints
   *  nothing). True when it taught a shape something new (a first sample or a
   *  moved median). */
  record(
    row: TranscriptRowModel,
    width: number,
    size: number,
    surface?: TranscriptRowSurface,
    variant?: string
  ): boolean;
}

export function createTranscriptRowHeightStore(
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
): TranscriptRowHeightStore {
  const keys = new Map<string, number>();
  const shapes = new Map<string, number[]>();
  const medians = new Map<string, number>();
  const sampled = new Set<string>();
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const stored = raw ? (JSON.parse(raw) as Partial<StoredHeights>) : null;
    for (const [key, size] of stored?.keys ?? []) if (typeof key === 'string' && size >= 0) keys.set(key, size);
    for (const [shape, samples] of stored?.shapes ?? []) {
      if (typeof shape !== 'string' || !Array.isArray(samples) || samples.length === 0) continue;
      shapes.set(shape, samples.slice(-SHAPE_SAMPLES));
      medians.set(shape, median(samples));
    }
  } catch {
    /* unreadable store: start empty */
  }
  const save = () => {
    saveTimer = null;
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify({ keys: [...keys], shapes: [...shapes] } satisfies StoredHeights));
    } catch {
      /* quota or private mode: estimates stay in memory */
    }
  };
  const scheduleSave = () => {
    if (!storage || saveTimer) return;
    saveTimer = setTimeout(save, SAVE_DELAY_MS);
  };
  // Coding keys carry no surface: the heights stored before surfaces existed
  // were all learned there.
  const surfaceOf = (surface: TranscriptRowSurface) => (surface === 'coding' ? '' : `${surface}|`);
  // No variant leaves the key as it was stored before variants existed.
  const variantOf = (variant = '') => (variant ? `|${variant}` : '');
  const keyAt = (row: TranscriptRowModel, width: number, surface: TranscriptRowSurface = 'coding', variant?: string) =>
    `${surfaceOf(surface)}${Math.round(width)}|${row.key}${variantOf(variant)}`;
  const shapeAt = (
    row: TranscriptRowModel,
    width: number,
    surface: TranscriptRowSurface = 'coding',
    variant?: string
  ) =>
    `${surfaceOf(surface)}${Math.round(width / SHAPE_WIDTH_STEP) * SHAPE_WIDTH_STEP}|${transcriptRowShape(row)}${variantOf(variant)}`;
  return {
    estimate(row, width, surface, variant) {
      if (!row || !(width > 0)) return TRANSCRIPT_ROW_ESTIMATE;
      const known = keys.get(keyAt(row, width, surface, variant));
      if (known !== undefined) return known;
      return medians.get(shapeAt(row, width, surface, variant)) ?? TRANSCRIPT_ROW_ESTIMATE;
    },
    knows(row, width, surface, variant) {
      if (!row || !(width > 0)) return false;
      return keys.has(keyAt(row, width, surface, variant)) || medians.has(shapeAt(row, width, surface, variant));
    },
    record(row, width, size, surface, variant) {
      if (!(width > 0) || !(size >= 0)) return false;
      const rounded = Math.round(size);
      const key = keyAt(row, width, surface, variant);
      if (persistentKey(row)) {
        if (keys.get(key) !== rounded) {
          keys.delete(key);
          keys.set(key, rounded);
          while (keys.size > KEY_LIMIT) {
            const oldest = keys.keys().next().value;
            if (oldest === undefined) break;
            keys.delete(oldest);
          }
          scheduleSave();
        }
      }
      // One sample per row: a row re-measured on every streamed chunk or
      // toggle must not outvote the rest of its shape.
      if (sampled.has(key)) return false;
      if (sampled.size >= KEY_LIMIT * 4) sampled.clear();
      sampled.add(key);
      const shape = shapeAt(row, width, surface, variant);
      const before = medians.get(shape);
      const samples = shapes.get(shape) ?? [];
      samples.push(rounded);
      if (samples.length > SHAPE_SAMPLES) samples.splice(0, samples.length - SHAPE_SAMPLES);
      shapes.delete(shape);
      shapes.set(shape, samples);
      medians.set(shape, median(samples));
      while (shapes.size > SHAPE_LIMIT) {
        const oldest = shapes.keys().next().value;
        if (oldest === undefined) break;
        shapes.delete(oldest);
        medians.delete(oldest);
      }
      scheduleSave();
      return medians.get(shape) !== before;
    },
  };
}

let sharedStore: TranscriptRowHeightStore | null = null;

/** The app-wide store, persisted in localStorage. */
export function transcriptRowHeightStore(): TranscriptRowHeightStore {
  if (!sharedStore) {
    let storage: Storage | null = null;
    try {
      storage = typeof window !== 'undefined' ? window.localStorage : null;
    } catch {
      storage = null;
    }
    sharedStore = createTranscriptRowHeightStore(storage);
  }
  return sharedStore;
}
