// The window a positioned subscription holds (`thread/resume` with `positionedWindow`): the ranges of the transcript the
// core granted it and the rows of each stored record they hold, as `thread/snapshot.window`, `thread/window/changed` and
// `thread/transcript/changed` tell them (protocol: `SnapshotWindow`, `ThreadWindowChangedParams`, `TranscriptChange`).
import { asObj } from './obj.ts';
import type { Obj } from './obj.ts';
import { rowsOf } from './rows.ts';

/** The range a followed tail makes (the core's `TAIL_RANGE`). */
export const TAIL_RANGE = 'tail';

/** One stored record's rows, and the core items they were folded from. */
export interface HeldUnit {
  readonly rows: readonly Obj[];
  readonly items: readonly string[];
}

/** A granted range: the positions of the records it holds, oldest first, and where it continues (null: the transcript ends
 *  there on that side). */
export interface HeldRange {
  readonly id: string;
  readonly older: string | null;
  readonly newer: string | null;
  readonly positions: readonly string[];
}

export interface HeldWindow {
  readonly version: number;
  readonly lineage: number;
  readonly followTail: boolean;
  /** In the order the core listed them. */
  readonly ranges: readonly HeldRange[];
  readonly units: ReadonlyMap<string, HeldUnit>;
}

/** Ranges that share a record are one stretch of the transcript: a run. */
export interface WindowRun {
  readonly ranges: readonly string[];
  readonly positions: readonly string[];
  readonly older: string | null;
  readonly newer: string | null;
  /** The run holds the followed tail. */
  readonly tail: boolean;
  readonly rows: number;
  /** The place in the window's range list of its latest range: the run asked for last ranks highest. */
  readonly rank: number;
}

/** Called with every row a unit folds to and the core item it came from. */
export type RowOwner = (row: Obj, item: string) => void;

const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const edge = (value: unknown): string | null => {
  const e = asObj(value);
  return e.kind === 'continuation' && typeof e.position === 'string' ? e.position : null;
};

/** A `TranscriptUnit` as its rows. */
export function unitOf(value: unknown, own: RowOwner): { position: string; unit: HeldUnit } | null {
  const u = asObj(value);
  if (typeof u.position !== 'string') return null;
  const rows: Obj[] = [];
  const items: string[] = [];
  for (const raw of list(u.items)) {
    const item = asObj(raw);
    const id = typeof item.id === 'string' ? item.id : undefined;
    if (id !== undefined) items.push(id);
    for (const row of rowsOf(item)) {
      if (id !== undefined) own(row, id);
      rows.push(row);
    }
  }
  return { position: u.position, unit: { rows, items } };
}

/** The records no range holds any more are let go. */
function pruned(window: HeldWindow & { units: Map<string, HeldUnit> }): HeldWindow {
  const kept = new Set(window.ranges.flatMap((range) => range.positions));
  for (const position of [...window.units.keys()]) if (!kept.has(position)) window.units.delete(position);
  return window;
}

/** The window `params` (a snapshot's `window`, or `thread/window/changed`) states, over the one held before it: a range it
 *  adds holds exactly the units it carries, one it lists and does not add keeps what it held, and one it does not list is
 *  let go. A snapshot's window is the whole truth: it is applied over none. */
export function windowChanged(held: HeldWindow | undefined, params: unknown, own: RowOwner): HeldWindow {
  const p = asObj(params);
  const units = new Map(held?.units ?? []);
  const added = new Map<string, string[]>();
  for (const raw of list(p.added)) {
    const add = asObj(raw);
    if (typeof add.range !== 'string') continue;
    const positions: string[] = [];
    for (const value of list(add.units)) {
      const read = unitOf(value, own);
      if (!read) continue;
      units.set(read.position, read.unit);
      if (!positions.includes(read.position)) positions.push(read.position);
    }
    added.set(add.range, positions);
  }
  const before = new Map((held?.ranges ?? []).map((range) => [range.id, range]));
  const ranges = list(p.ranges).flatMap((raw): HeldRange[] => {
    const range = asObj(raw);
    if (typeof range.id !== 'string') return [];
    const positions = added.get(range.id) ?? before.get(range.id)?.positions ?? [];
    return [{ id: range.id, older: edge(range.older), newer: edge(range.newer), positions }];
  });
  return pruned({
    version: typeof p.windowVersion === 'number' ? p.windowVersion : (held?.version ?? 0),
    lineage: typeof p.lineage === 'number' ? p.lineage : (held?.lineage ?? 0),
    followTail: p.followTail === true,
    ranges,
    units,
  });
}

/** What a `TranscriptChange` did: the window after it, and the core items and rows of the unit it told (the rows shown
 *  for them until the record was stored give way to it). Null when it changes nothing this window holds. */
export interface Changed {
  readonly window: HeldWindow;
  /** The record's position. */
  readonly position: string;
  readonly items: readonly string[];
  readonly rows: readonly Obj[];
}

export function transcriptChanged(held: HeldWindow, change: unknown, own: RowOwner): Changed | null {
  const c = asObj(change);
  if (c.op === 'remove') {
    if (typeof c.position !== 'string' || !held.units.has(c.position)) return null;
    const gone = held.units.get(c.position)!;
    const ranges = held.ranges.map((range) =>
      range.positions.includes(c.position as string)
        ? { ...range, positions: range.positions.filter((position) => position !== c.position) }
        : range
    );
    const units = new Map(held.units);
    units.delete(c.position);
    return { window: { ...held, ranges, units }, position: c.position, items: gone.items, rows: gone.rows };
  }
  const read = unitOf(c.unit, own);
  if (!read) return null;
  const { position, unit } = read;
  if (c.op === 'replace') {
    if (!held.units.has(position)) return null;
    const units = new Map(held.units);
    units.set(position, unit);
    return { window: { ...held, units }, position, items: unit.items, rows: unit.rows };
  }
  if (c.op !== 'insert') return null;
  const units = new Map(held.units);
  units.set(position, unit);
  const ranges = held.ranges.slice();
  const at = ranges.findIndex((range) => range.id === TAIL_RANGE);
  if (at < 0) {
    // The first record the followed tail holds makes its range; one stored before it is where the range continues.
    ranges.push({
      id: TAIL_RANGE,
      older: typeof c.after === 'string' ? position : null,
      newer: null,
      positions: [position],
    });
  } else {
    const tail = ranges[at]!;
    ranges[at] = {
      ...tail,
      newer: null,
      positions: tail.positions.includes(position) ? tail.positions : [...tail.positions, position],
    };
  }
  return { window: { ...held, ranges, units }, position, items: unit.items, rows: unit.rows };
}

/** `a` and `b`, two stretches of one sequence that share a position, as the one stretch they make; null when they share
 *  none. */
function joined(a: readonly string[], b: readonly string[]): string[] | null {
  const inA = new Map(a.map((position, index) => [position, index]));
  for (let j = 0; j < b.length; j++) {
    const i = inA.get(b[j]!);
    if (i === undefined) continue;
    const prefix = i >= j ? a.slice(0, i) : b.slice(0, j);
    const suffix = a.length - i >= b.length - j ? a.slice(i) : b.slice(j);
    return [...prefix, ...suffix];
  }
  return null;
}

const runsOf = new WeakMap<HeldWindow, readonly WindowRun[]>();

/** The window's runs: the ranges joined where they share a record. */
export function windowRuns(window: HeldWindow): readonly WindowRun[] {
  const known = runsOf.get(window);
  if (known) return known;
  let groups: Array<{ ranges: HeldRange[]; positions: string[]; rank: number }> = [];
  window.ranges.forEach((range, rank) => {
    if (!range.positions.length) return;
    let group = { ranges: [range], positions: range.positions.slice(), rank };
    const rest: typeof groups = [];
    for (const other of groups) {
      const merged = joined(other.positions, group.positions);
      if (merged) group = { ranges: [...other.ranges, ...group.ranges], positions: merged, rank };
      else rest.push(other);
    }
    groups = [...rest, group];
  });
  const runs = groups.map((group): WindowRun => {
    const first = group.positions[0];
    const last = group.positions.at(-1);
    const starting = group.ranges.filter((range) => range.positions[0] === first);
    const ending = group.ranges.filter((range) => range.positions.at(-1) === last);
    let rows = 0;
    for (const position of group.positions) rows += window.units.get(position)?.rows.length ?? 0;
    return {
      ranges: group.ranges.map((range) => range.id),
      positions: group.positions,
      older: starting.some((range) => range.older === null) ? null : (starting[0]?.older ?? null),
      newer: ending.some((range) => range.newer === null) ? null : (ending[0]?.newer ?? null),
      tail: group.ranges.some((range) => range.id === TAIL_RANGE),
      rows,
      rank: group.rank,
    };
  });
  runsOf.set(window, runs);
  return runs;
}

/** The run that holds the followed tail. */
export const tailRun = (window: HeldWindow): WindowRun | undefined => windowRuns(window).find((run) => run.tail);

/** The run the reader is shown apart from the tail: the one asked for last. */
export function viewRun(window: HeldWindow): WindowRun | undefined {
  let view: WindowRun | undefined;
  for (const run of windowRuns(window)) if (!run.tail && (!view || run.rank > view.rank)) view = run;
  return view;
}

/** The rows of `run`, oldest first. */
export function runRows(window: HeldWindow, run: WindowRun | undefined): Obj[] {
  if (!run) return [];
  const rows: Obj[] = [];
  for (const position of run.positions) {
    const unit = window.units.get(position);
    if (unit) for (const row of unit.rows) rows.push(row);
  }
  return rows;
}

/** The unit that shows `id` (a row's id, or a core item's). */
export function unitShowing(window: HeldWindow, id: string, itemOf: (row: Obj) => string | undefined): string | undefined {
  for (const [position, unit] of window.units) {
    if (unit.items.includes(id) || unit.rows.some((row) => row.id === id || itemOf(row) === id)) return position;
  }
  return undefined;
}

/** `window` with every record after `position` in its run let go, and with the run of the followed tail let go whole when
 *  `position` lies in another run (that run is older than the tail). */
export function cutAfter(window: HeldWindow, position: string): HeldWindow {
  const runs = windowRuns(window);
  const run = runs.find((candidate) => candidate.positions.includes(position));
  if (!run) return window;
  const gone = new Set(run.positions.slice(run.positions.indexOf(position) + 1));
  if (!run.tail) for (const other of runs) if (other.tail) for (const held of other.positions) gone.add(held);
  if (!gone.size) return window;
  const ranges = window.ranges.map((range) =>
    range.positions.some((held) => gone.has(held))
      ? { ...range, newer: null, positions: range.positions.filter((held) => !gone.has(held)) }
      : range
  );
  return pruned({ ...window, ranges, units: new Map(window.units) });
}

/** The window with nothing held (a clear). */
export const emptied = (window: HeldWindow): HeldWindow => ({
  ...window,
  ranges: window.ranges.map((range) => ({ ...range, older: null, newer: null, positions: [] })),
  units: new Map(),
});
