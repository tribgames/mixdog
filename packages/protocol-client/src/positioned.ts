// The window a positioned subscription holds (`thread/resume` with `positionedWindow`): the ranges of the transcript the
// core granted it and the rows of each stored record they hold, as `thread/snapshot.window`, `thread/window/changed` and
// `thread/transcript/changed` tell them (protocol: `SnapshotWindow`, `ThreadWindowChangedParams`, `TranscriptChange`).
import { asObj } from './obj.ts';
import type { Obj } from './obj.ts';
import { countMergedRows, rowsOf } from './rows.ts';

/** The range a followed tail makes (the core's `TAIL_RANGE`). */
export const TAIL_RANGE = 'tail';

/** One stored record's rows, and the core items they were folded from. */
export interface HeldUnit {
  readonly rows: readonly Obj[];
  readonly items: readonly string[];
  /** Where the record stands in its lineage's log (`TranscriptUnit.ordinal`): what the records held are ordered by. */
  readonly ordinal?: number;
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
  /** A record joined the followed tail whose predecessor the tail does not hold: the records between the one named
   *  here (the newest held before the hole) and it are still to be read (transcript-window.ts `mendTranscriptWindow`). */
  readonly gap?: string;
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

/** Test seam: what a fold's frames cost, counted while a counter is set. `placed`: rows laid out again; `copied`:
 *  entries of what is held (records, positions, ids, rows) copied or walked to make the next window; `merged`: rows
 *  the transcript's merge read. */
export interface FoldWork {
  placed: number;
  copied: number;
  merged: number;
}
let work: FoldWork | null = null;
export function countFoldWork(counter: FoldWork | null): void {
  work = counter;
  countMergedRows(counter);
}
export const foldWork = (): FoldWork | null => work;

/** The rows each range holds, by the range: counted once, and carried on as records join or change. */
const rowsOfRange = new WeakMap<HeldRange, number>();
export function rangeRows(window: HeldWindow, id: string): number {
  const range = window.ranges.find((candidate) => candidate.id === id);
  if (!range) return 0;
  let rows = rowsOfRange.get(range);
  if (rows === undefined) {
    rows = 0;
    for (const position of range.positions) rows += window.units.get(position)?.rows.length ?? 0;
    if (work) work.copied += range.positions.length;
    rowsOfRange.set(range, rows);
  }
  return rows;
}

/** Called with every row a unit folds to and the core item it came from. */
export type RowOwner = (row: Obj, item: string) => void;

const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const edge = (value: unknown): string | null => {
  const e = asObj(value);
  return e.kind === 'continuation' && typeof e.position === 'string' ? e.position : null;
};

/** A record told again brings its text again: a frame parses to strings of its own. The reader keeps the row it holds
 *  when the row told is equal to it, so the fold would hold a second copy of every text for as long as both live. The
 *  texts of `row` that are the texts `held` holds in the same places become the strings held. */
export function adoptHeldText(row: Obj, held: Obj): void {
  for (const key in row) {
    const told = row[key];
    const prior = held[key];
    if (typeof told === 'string') {
      if (typeof prior === 'string' && told.length === prior.length && told === prior) row[key] = prior;
    } else if (told && prior && typeof told === 'object' && typeof prior === 'object' && Array.isArray(told) === Array.isArray(prior)) {
      adoptHeldText(told as Obj, prior as Obj);
    }
  }
}

/** `unit` with the texts of the rows `held` shows under the same ids. */
function adoptHeldUnit(unit: HeldUnit, held: HeldUnit | undefined): HeldUnit {
  if (!held || held === unit) return unit;
  for (const row of unit.rows) {
    const prior = held.rows.find((candidate) => candidate.id === row.id);
    if (prior && prior !== row) adoptHeldText(row, prior);
  }
  return unit;
}

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
  return { position: u.position, unit: { rows, items, ...(typeof u.ordinal === 'number' ? { ordinal: u.ordinal } : {}) } };
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
      units.set(read.position, adoptHeldUnit(read.unit, held?.units.get(read.position)));
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
  // A tail the change reads anew, or no longer lists, has no hole left from before.
  const gap = held?.gap !== undefined && !added.has(TAIL_RANGE) && ranges.some((range) => range.id === TAIL_RANGE);
  return pruned({
    version: typeof p.windowVersion === 'number' ? p.windowVersion : (held?.version ?? 0),
    lineage: typeof p.lineage === 'number' ? p.lineage : (held?.lineage ?? 0),
    followTail: p.followTail === true,
    ranges,
    units,
    ...(gap ? { gap: held!.gap } : {}),
  });
}

/** What the records of a window show, by id (a row's, a core item's): the record that shows each. One index serves a
 *  line of windows made from one another: it belongs to the newest (`owner`) and takes each record told, so nothing
 *  held is read again for a record that arrives. An entry may outlive its record; a lookup is checked against the
 *  record it names. A window off the line (an earlier one, another branch) builds its own. */
interface Shown {
  readonly ids: Map<unknown, string>;
  owner: ReadonlyMap<string, HeldUnit>;
}
const shownOf = new WeakMap<ReadonlyMap<string, HeldUnit>, Shown>();
const noteShown = (ids: Map<unknown, string>, position: string, unit: HeldUnit): void => {
  for (const item of unit.items) ids.set(item, position);
  for (const row of unit.rows) ids.set(row.id, position);
};
/** The record of `window` that shows `id`. */
export function shownAt(window: HeldWindow, id: unknown): string | undefined {
  if (id === undefined) return undefined;
  let shown = shownOf.get(window.units);
  if (!shown || shown.owner !== window.units) {
    shown = { ids: new Map(), owner: window.units };
    for (const [position, unit] of window.units) noteShown(shown.ids, position, unit);
    if (work) work.copied += window.units.size;
    shownOf.set(window.units, shown);
  }
  const position = shown.ids.get(id);
  if (position === undefined) return undefined;
  const shows = (unit: HeldUnit | undefined): boolean =>
    unit !== undefined && (unit.items.includes(id as string) || unit.rows.some((row) => row.id === id));
  if (shows(window.units.get(position))) return position;
  // The record the id was last told for shows it no more (let go, or told without it). Another may: the records are
  // read once, and the entry then names that one or is gone.
  if (work) work.copied += window.units.size;
  for (const [other, unit] of window.units) {
    if (!shows(unit)) continue;
    shown.ids.set(id, other);
    return other;
  }
  shown.ids.delete(id);
  return undefined;
}
/** `next` was made from `prior` by telling the record at `position`: the line's index goes on to it. */
function carryShown(
  prior: ReadonlyMap<string, HeldUnit>,
  next: ReadonlyMap<string, HeldUnit>,
  position: string
): void {
  const shown = shownOf.get(prior);
  if (!shown || shown.owner !== prior) return;
  const unit = next.get(position);
  if (unit) noteShown(shown.ids, position, unit);
  shown.owner = next;
  shownOf.set(next, shown);
}

/** A run's records by place, and the rows before each: `upTo[i]` is the rows of the records before the i-th. Made
 *  once for a run and carried on to the run a record joined at its end; a place read is checked against the run. */
export interface RunLayout {
  readonly index: Map<string, number>;
  readonly upTo: number[];
}
const layoutOf = new WeakMap<WindowRun, RunLayout>();
export function runLayout(window: HeldWindow, run: WindowRun): RunLayout {
  let layout = layoutOf.get(run);
  if (!layout) {
    layout = { index: new Map(), upTo: [0] };
    run.positions.forEach((position, at) => {
      layout!.index.set(position, at);
      layout!.upTo.push(layout!.upTo[at]! + (window.units.get(position)?.rows.length ?? 0));
    });
    if (work) work.copied += run.positions.length;
    layoutOf.set(run, layout);
  }
  return layout;
}
/** The place in `run` of the record that shows `id` (a row's id, or a core item's); -1 when the run shows none. */
export function placeInRun(window: HeldWindow, run: WindowRun, id: string): number {
  const position = shownAt(window, id);
  if (position === undefined) return -1;
  const at = runLayout(window, run).index.get(position);
  return at !== undefined && run.positions[at] === position ? at : -1;
}

/** The records of a window after a few were told: the records it was made from (`base`) with those told since laid
 *  over them (`over`; null: let go). A record told costs what was told since the last whole copy, not what is held:
 *  the whole is copied once every UNITS_OVER records. Reads as the map it stands for. */
const UNITS_OVER = 64;
class ToldUnits implements ReadonlyMap<string, HeldUnit> {
  readonly [Symbol.toStringTag] = 'Map';
  readonly base: ReadonlyMap<string, HeldUnit>;
  readonly over: ReadonlyMap<string, HeldUnit | null>;
  readonly size: number;
  constructor(base: ReadonlyMap<string, HeldUnit>, over: ReadonlyMap<string, HeldUnit | null>, size: number) {
    this.base = base;
    this.over = over;
    this.size = size;
  }
  get(position: string): HeldUnit | undefined {
    const told = this.over.get(position);
    return told === undefined ? this.base.get(position) : (told ?? undefined);
  }
  has(position: string): boolean {
    const told = this.over.get(position);
    return told === undefined ? this.base.has(position) : told !== null;
  }
  *entries(): Generator<[string, HeldUnit], undefined, unknown> {
    for (const [position, unit] of this.base) {
      const told = this.over.get(position);
      if (told === undefined) yield [position, unit];
      else if (told !== null) yield [position, told];
    }
    for (const [position, told] of this.over) if (told !== null && !this.base.has(position)) yield [position, told];
    return undefined;
  }
  *keys(): Generator<string, undefined, unknown> {
    for (const [position] of this.entries()) yield position;
    return undefined;
  }
  *values(): Generator<HeldUnit, undefined, unknown> {
    for (const [, unit] of this.entries()) yield unit;
    return undefined;
  }
  [Symbol.iterator](): Generator<[string, HeldUnit], undefined, unknown> {
    return this.entries();
  }
  forEach(each: (unit: HeldUnit, position: string, map: ReadonlyMap<string, HeldUnit>) => void): void {
    for (const [position, unit] of this.entries()) each(unit, position, this);
  }
}

/** `units` with the record at `position` told as `unit` (null: let go). */
function toldUnits(
  units: ReadonlyMap<string, HeldUnit>,
  position: string,
  unit: HeldUnit | null
): ReadonlyMap<string, HeldUnit> {
  const layered = units instanceof ToldUnits ? units : undefined;
  if (layered && layered.over.size >= UNITS_OVER) {
    const whole = new Map(units);
    if (work) work.copied += whole.size;
    if (unit) whole.set(position, unit);
    else whole.delete(position);
    return whole;
  }
  const over = new Map(layered?.over);
  if (work) work.copied += over.size;
  over.set(position, unit);
  const held = units.has(position);
  return new ToldUnits(layered?.base ?? units, over, units.size + (unit ? (held ? 0 : 1) : held ? -1 : 0));
}

/** How many changes back a reader of a run looks for the units it last read: one that fell further behind reads again. */
const CHANGES_BACK = 64;
/** The records told along a line of units made from one another: the positions of its last CHANGES_BACK changes. A
 *  units map knows its place on the line and nothing of the maps before it, so a superseded map, with its records and
 *  their rows, is unreachable once the change that replaced it is applied. */
interface ChangeLine {
  readonly positions: string[];
  /** The change `positions[0]` is. */
  first: number;
  latest: number;
}
const changeOf = new WeakMap<ReadonlyMap<string, HeldUnit>, { line: ChangeLine; seq: number }>();
/** `next` was made from `prior` by telling the record at `position`. Two maps made from one are two lines. */
function noteChange(prior: ReadonlyMap<string, HeldUnit>, next: ReadonlyMap<string, HeldUnit>, position: string): void {
  const before = changeOf.get(prior);
  const line = before && before.seq === before.line.latest ? before.line : { positions: [], first: 1, latest: 0 };
  if (line !== before?.line) changeOf.set(prior, { line, seq: 0 });
  line.positions.push(position);
  line.latest += 1;
  if (line.positions.length > CHANGES_BACK) {
    line.positions.shift();
    line.first += 1;
  }
  changeOf.set(next, { line, seq: line.latest });
}
const runPositions = new WeakMap<WindowRun, ReadonlySet<string>>();

/** Whether `run` holds the same records in `units` as it did in `since`: `units` was made from `since` by changes of
 *  records the run does not hold. Looks at the changes, not at the run's records. */
export function runUnchanged(
  run: WindowRun,
  units: ReadonlyMap<string, HeldUnit>,
  since: ReadonlyMap<string, HeldUnit>
): boolean {
  let held = runPositions.get(run);
  if (!held) runPositions.set(run, (held = new Set(run.positions)));
  if (units === since) return true;
  const now = changeOf.get(units);
  const then = changeOf.get(since);
  if (!now || !then || now.line !== then.line || now.seq < then.seq) return false;
  const { positions, first } = now.line;
  if (then.seq + 1 < first) return false;
  for (let seq = then.seq + 1; seq <= now.seq; seq += 1) if (held.has(positions[seq - first]!)) return false;
  return true;
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
    const units = toldUnits(held.units, c.position, null);
    noteChange(held.units, units, c.position);
    carryShown(held.units, units, c.position);
    return { window: { ...held, ranges, units }, position: c.position, items: gone.items, rows: gone.rows };
  }
  const read = unitOf(c.unit, own);
  if (!read) return null;
  const { position, unit } = read;
  if (c.op === 'replace') {
    if (!held.units.has(position)) return null;
    const was = held.units.get(position)!;
    const units = toldUnits(held.units, position, adoptHeldUnit(unit, was));
    noteChange(held.units, units, position);
    carryShown(held.units, units, position);
    const window: HeldWindow = { ...held, units };
    // The record reads differently where it stands: the ranges and runs are the ones held, their rows counted on.
    const grew = unit.rows.length - was.rows.length;
    const known = runsOf.get(held);
    if (known && grew === 0) runsOf.set(window, known);
    else if (known) {
      if (work) work.copied += known.length;
      runsOf.set(window, known.map((run) => (run.positions.includes(position) ? { ...run, rows: run.rows + grew } : run)));
    }
    if (grew !== 0) for (const range of held.ranges) if (range.positions.includes(position)) rowsOfRange.delete(range);
    return { window, position, items: unit.items, rows: unit.rows };
  }
  if (c.op !== 'insert') return null;
  let gap = held.gap;
  let appended = false;
  const units = toldUnits(held.units, position, unit);
  noteChange(held.units, units, position);
  carryShown(held.units, units, position);
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
    if (held.units.has(position) && tail.positions.includes(position)) {
      ranges[at] = { ...tail, newer: null };
    } else {
      // The record stands where its ordinal says, among the records the tail holds: after the newest one stored
      // before it. One that states no ordinal is the newest.
      let place = tail.positions.length;
      if (unit.ordinal !== undefined)
        while (place > 0 && (held.units.get(tail.positions[place - 1]!)?.ordinal ?? -1) > unit.ordinal) place -= 1;
      const before = tail.positions[place - 1];
      // The core names the stored record shown before it. The tail holding another there has a hole between them; so
      // has a tail the record lands before all of: what lies between it and the tail's first record is not known.
      if (typeof c.after === 'string' && before !== undefined && before !== c.after && !tail.positions.includes(c.after))
        gap = before;
      else if (before === undefined && tail.positions.length > 0) gap = position;
      const positions =
        place === tail.positions.length
          ? [...tail.positions, position]
          : [...tail.positions.slice(0, place), position, ...tail.positions.slice(place)];
      if (work) work.copied += positions.length;
      const joined_ = { ...tail, newer: null, positions };
      const counted = rowsOfRange.get(tail);
      if (counted !== undefined) rowsOfRange.set(joined_, counted + unit.rows.length);
      ranges[at] = joined_;
      appended = place === positions.length - 1;
    }
  }
  const window: HeldWindow = { ...held, ranges, units, ...(gap !== undefined ? { gap } : {}) };
  if (appended) carryRuns(held, window, position, unit);
  return { window, position, items: unit.items, rows: unit.rows };
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

/** `a` and `b` as one stretch when they share a record: ordered by the ordinals their records state, and where one
 *  states none, by the order each range lists (`joined`). */
function merged(window: HeldWindow, a: readonly string[], b: readonly string[]): string[] | null {
  const inA = new Set(a);
  if (!b.some((position) => inA.has(position))) return null;
  const all = [...a, ...b.filter((position) => !inA.has(position))];
  const ordinals = all.map((position) => window.units.get(position)?.ordinal);
  if (ordinals.some((ordinal) => ordinal === undefined)) return joined(a, b);
  const order = new Map(all.map((position, at) => [position, ordinals[at]!]));
  return all.sort((x, y) => order.get(x)! - order.get(y)!);
}

const runsOf = new WeakMap<HeldWindow, readonly WindowRun[]>();

/** The runs of `next`, which is `prior` with the record at `position` joined to the newest end of its tail: the runs
 *  `prior` has, the tail's one record longer. Nothing is joined again for a record that arrives. */
function carryRuns(prior: HeldWindow, next: HeldWindow, position: string, unit: HeldUnit): void {
  const known = runsOf.get(prior);
  const tail = known?.find((run) => run.tail);
  if (!known || !tail) return;
  const longer: WindowRun = { ...tail, positions: [...tail.positions, position], newer: null, rows: tail.rows + unit.rows.length };
  if (work) work.copied += longer.positions.length;
  // The run's layout goes on to the longer run, once: a second run made from the same one lays itself out.
  const layout = layoutOf.get(tail);
  if (layout && layout.upTo.length === tail.positions.length + 1) {
    layout.index.set(position, tail.positions.length);
    layout.upTo.push(layout.upTo.at(-1)! + unit.rows.length);
    layoutOf.set(longer, layout);
  }
  runsOf.set(
    next,
    known.map((run) => (run === tail ? longer : run))
  );
}

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
      const one = merged(window, other.positions, group.positions);
      if (one) group = { ranges: [...other.ranges, ...group.ranges], positions: one, rank };
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

/** Every run apart from the tail, the one asked for last being last: each is a stretch some reader may be shown. */
export function viewRuns(window: HeldWindow): readonly WindowRun[] {
  return windowRuns(window)
    .filter((run) => !run.tail)
    .sort((a, b) => a.rank - b.rank);
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
