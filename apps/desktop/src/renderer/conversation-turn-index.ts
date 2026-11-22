import type { TranscriptItem } from './desktop-types';
import { carriedFrom } from './list-carry';
import { linkedLocalPaths } from './markdown-plugins';
import type { TranscriptRowModel } from './transcript-rows';
import type { TurnChangesRef } from './turn-changes-model';
import { visualizedTargets, visualizeTurnEndAt } from './visualize-card-model';

// Re-indexing immutable items can reuse their links without pinning reply
// bodies after a page or a streaming revision leaves the timeline.
const linkedCache = new WeakMap<TranscriptItem, readonly string[]>();

function linkedIn(item: TranscriptItem, text: string): readonly string[] {
  let paths = linkedCache.get(item);
  if (!paths) {
    paths = linkedLocalPaths(text);
    linkedCache.set(item, paths);
  }
  return paths;
}

/** What the rows say about one turn. */
export type TurnIndexEntry = {
  /** What earlier turns surfaced: the files their replies linked and the
   *  targets they opened in the panel. Read from the rows themselves, so it
   *  holds after a reload and on a paired device. Shared by turns that
   *  follow the same rows, so its identity is stable across renders. */
  surfacedBefore: readonly string[];
  /** The text of the turn's final reply part (what its previews look for). */
  replyText: string;
  /** When the turn's rows were last recorded (ms): its previews' time. */
  endedAt: number;
  /** The turn's changed-files card (on its reply or error row). */
  changes: TurnChangesRef | undefined;
  /** The files the turn's tool rounds showed as visualize cards. */
  visualized(): readonly string[];
  /** The items of the turn's tool rounds, oldest first: the same list while the rounds are the same. */
  toolItems(): readonly TranscriptItem[];
  /** The turn's last row, its live band aside. */
  lastRow: number;
  /** The turn still runs: its live band or a streaming reply part is among the rows. */
  running: boolean;
  /** The rows of its live band and streaming reply parts, oldest first. */
  liveRows: readonly number[];
  /** The rows of its reply parts, oldest first. */
  replyRows: readonly number[];
};

/** What one turn's rows gave, each with the row it came from, oldest first: the rows from some row on are taken back by
 *  dropping the ends of these lists. */
class TurnRows implements TurnIndexEntry {
  /** The turn's rows other than its live band. */
  readonly rows: number[] = [];
  readonly liveRows: number[] = [];
  /** The latest time recorded up to each of its timed rows. */
  readonly timedRows: number[] = [];
  readonly times: number[] = [];
  readonly replyRows: number[] = [];
  readonly replies: string[] = [];
  readonly changeRows: number[] = [];
  readonly changeRefs: TurnChangesRef[] = [];
  readonly groupRows: number[] = [];
  readonly groups: (readonly TranscriptItem[])[] = [];
  private flat: readonly TranscriptItem[] | undefined;
  private shown: readonly string[] | undefined;

  constructor(
    readonly surfacedBefore: readonly string[],
    private readonly targetsOf: (items: readonly TranscriptItem[]) => string[]
  ) {}

  get replyText(): string {
    return this.replies.at(-1) ?? '';
  }
  get endedAt(): number {
    return this.times.at(-1) ?? 0;
  }
  get changes(): TurnChangesRef | undefined {
    return this.changeRefs[0];
  }
  get lastRow(): number {
    return this.rows.at(-1) ?? -1;
  }
  get running(): boolean {
    return this.liveRows.length > 0;
  }
  toolItems(): readonly TranscriptItem[] {
    return (this.flat ??= this.groups.flat());
  }
  visualized(): readonly string[] {
    return (this.shown ??= this.targetsOf(this.toolItems()));
  }
  time(row: number, at: number): void {
    this.timedRows.push(row);
    this.times.push(Math.max(this.endedAt, at));
  }
  group(row: number, items: readonly TranscriptItem[]): void {
    this.groupRows.push(row);
    this.groups.push(items);
    this.flat = undefined;
    this.shown = undefined;
  }
  /** Forgets what the rows from `from` on gave; false when the turn has no row left. */
  keepBefore(from: number): boolean {
    const drop = (rows: number[], values?: unknown[]) => {
      while (rows.length > 0 && (rows.at(-1) as number) >= from) {
        rows.pop();
        values?.pop();
      }
    };
    drop(this.rows);
    drop(this.liveRows);
    drop(this.timedRows, this.times);
    drop(this.replyRows, this.replies);
    drop(this.changeRows, this.changeRefs);
    if ((this.groupRows.at(-1) ?? -1) >= from) {
      this.flat = undefined;
      this.shown = undefined;
    }
    drop(this.groupRows, this.groups);
    return this.rows.length + this.liveRows.length > 0;
  }
}

/** The index of one list of rows, as it stands for the newest list carried on from it. */
interface CarriedIndex {
  rows: readonly TranscriptRowModel[];
  turns: Map<string, TurnRows>;
  /** What the rows surfaced, in order, with the row each came from. */
  surfaced: string[];
  surfacedRows: number[];
  surfacedSet: Set<string>;
  /** The list a turn's `surfacedBefore` was last made of. */
  snapshot: string[];
}

/** The per-turn index of a `rows` array. A list carried on from the one indexed before (list-carry.ts `noteCarried`) is
 *  indexed from the first row that changed: what the rows before it gave stands, and each turn's entry is the same object.
 *  `targetsOf` reads the visualize targets of a tool group; it runs once per group. */
export function createTurnIndexer(targetsOf: (items: readonly TranscriptItem[]) => string[]) {
  const groups = new WeakMap<readonly TranscriptItem[], { targets: readonly string[]; endAt: number }>();
  const groupOf = (items: readonly TranscriptItem[]) => {
    let group = groups.get(items);
    if (!group) {
      group = { targets: targetsOf(items), endAt: visualizeTurnEndAt(items) };
      groups.set(items, group);
    }
    return group;
  };
  const indexes = new WeakMap<readonly TranscriptRowModel[], CarriedIndex>();

  function surface(index: CarriedIndex, row: number, path: string): void {
    if (index.surfacedSet.has(path)) return;
    index.surfacedSet.add(path);
    index.surfaced.push(path);
    index.surfacedRows.push(row);
  }

  /** Takes back what the rows from `from` on gave, then reads `rows` from there. */
  function carry(index: CarriedIndex, rows: readonly TranscriptRowModel[], from: number): void {
    const held = index.rows;
    for (let at = from; at < held.length; at += 1) {
      const turnKey = (held[at] as TranscriptRowModel).turnKey;
      const turn = index.turns.get(turnKey);
      if (turn && !turn.keepBefore(from)) index.turns.delete(turnKey);
    }
    while (index.surfaced.length > 0 && (index.surfacedRows.at(-1) as number) >= from) {
      index.surfacedRows.pop();
      index.surfacedSet.delete(index.surfaced.pop() as string);
    }
    // A list of another time: only one as long as what is surfaced now, made since, is still current.
    if (index.snapshot.length > index.surfaced.length) index.snapshot = [];
    for (let at = from; at < rows.length; at += 1) {
      const row = rows[at] as TranscriptRowModel;
      let turn = index.turns.get(row.turnKey);
      if (!turn) {
        if (index.snapshot.length !== index.surfaced.length) index.snapshot = index.surfaced.slice();
        turn = new TurnRows(index.snapshot, targetsOf);
        index.turns.set(row.turnKey, turn);
      }
      if (row._tag === 'Thinking' || (row._tag === 'AssistantPart' && row.live)) turn.liveRows.push(at);
      if (row._tag !== 'Thinking') turn.rows.push(at);
      if (row._tag === 'ToolActivity') {
        const group = groupOf(row.items);
        for (const target of group.targets) surface(index, at, target);
        turn.time(at, group.endAt);
        turn.group(at, row.items);
        continue;
      }
      if ('item' in row && row.item) {
        turn.time(at, Number(row.item.completedAt ?? row.item.at ?? row.item.startedAt) || 0);
      }
      if (row._tag === 'AssistantPart' && row.item.kind === 'assistant') {
        const text = String(row.item.text || '');
        for (const path of linkedIn(row.item, text)) surface(index, at, path);
        turn.replyRows.push(at);
        turn.replies.push(text);
      }
      if ((row._tag === 'AssistantPart' || row._tag === 'Error') && row.turnChanges) {
        turn.changeRows.push(at);
        turn.changeRefs.push(row.turnChanges);
      }
    }
    index.rows = rows;
  }

  /** The index of `rows`, as a map that is carried on in place: it is read at once and never kept. */
  function turnIndexOf(rows: readonly TranscriptRowModel[]): ReadonlyMap<string, TurnIndexEntry> {
    let index = indexes.get(rows);
    if (index?.rows === rows) return index.turns;
    const made = carriedFrom(rows);
    const before = made ? indexes.get(made.prior as readonly TranscriptRowModel[]) : undefined;
    if (made && before?.rows === made.prior) {
      index = before;
      carry(index, rows, made.kept);
    } else {
      // No list it was made from, or one whose index has been carried on past it (a render of rows older than the newest
      // indexed): these rows are indexed from nothing, apart from the index that moved on.
      index = { rows: [], turns: new Map(), surfaced: [], surfacedRows: [], surfacedSet: new Set(), snapshot: [] };
      carry(index, rows, 0);
    }
    indexes.set(rows, index);
    return index.turns;
  }

  return {
    turnIndexOf,
    /** What `rows` say about one of their turns. The rows are named on every read, so a reader holds no index: what it
     *  is given is of the rows it asked with, whichever rows were indexed last. */
    turnOf(rows: readonly TranscriptRowModel[], turnKey: string): TurnIndexEntry | undefined {
      return turnIndexOf(rows).get(turnKey);
    },
  };
}

export const { turnOf } = createTurnIndexer(visualizedTargets);
