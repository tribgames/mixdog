import type { TranscriptItem } from './desktop-types';
import { linkedLocalPaths } from './markdown-plugins';
import type { TranscriptRowModel } from './transcript-rows';
import type { TurnChangesRef } from './turn-changes-model';
import { visualizedTargets, visualizeTurnEndAt } from './visualize-card-model';

const linkedCache = new Map<string, readonly string[]>();

function linkedIn(text: string): readonly string[] {
  let paths = linkedCache.get(text);
  if (!paths) {
    paths = linkedLocalPaths(text);
    linkedCache.set(text, paths);
    if (linkedCache.size > 200) linkedCache.delete(linkedCache.keys().next().value as string);
  }
  return paths;
}

/** What the rows say about one turn, read once per `rows` array. */
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
};

/** The per-turn index of a `rows` array, built in one pass and kept for as
 *  long as that array lives. `targetsOf` reads the visualize targets of a
 *  tool group; it runs once per group. */
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
  const indexes = new WeakMap<readonly TranscriptRowModel[], ReadonlyMap<string, TurnIndexEntry>>();

  function build(rows: readonly TranscriptRowModel[]): Map<string, TurnIndexEntry> {
    const turns = new Map<string, TurnIndexEntry>();
    const toolGroups = new Map<string, (readonly TranscriptItem[])[]>();
    const surfaced = new Set<string>();
    // The set only grows, so a snapshot of its size is still current.
    let snapshot: string[] = [];
    for (const row of rows) {
      let turn = turns.get(row.turnKey);
      if (!turn) {
        if (snapshot.length !== surfaced.size) snapshot = [...surfaced];
        const groupsOfTurn: (readonly TranscriptItem[])[] = [];
        let visualized: readonly string[] | undefined;
        turn = {
          surfacedBefore: snapshot,
          replyText: '',
          endedAt: 0,
          changes: undefined,
          visualized: () => (visualized ??= targetsOf(groupsOfTurn.flat())),
        };
        turns.set(row.turnKey, turn);
        toolGroups.set(row.turnKey, groupsOfTurn);
      }
      if (row._tag === 'ToolActivity') {
        const group = groupOf(row.items);
        for (const target of group.targets) surfaced.add(target);
        turn.endedAt = Math.max(turn.endedAt, group.endAt);
        toolGroups.get(row.turnKey)?.push(row.items);
        continue;
      }
      if ('item' in row && row.item) {
        turn.endedAt = Math.max(turn.endedAt, Number(row.item.completedAt ?? row.item.at ?? row.item.startedAt) || 0);
      }
      if (row._tag === 'AssistantPart' && row.item.kind === 'assistant') {
        const text = String(row.item.text || '');
        for (const path of linkedIn(text)) surfaced.add(path);
        turn.replyText = text;
      }
      if (!turn.changes && (row._tag === 'AssistantPart' || row._tag === 'Error')) turn.changes = row.turnChanges;
    }
    return turns;
  }

  return {
    turnIndexOf(rows: readonly TranscriptRowModel[]): ReadonlyMap<string, TurnIndexEntry> {
      let index = indexes.get(rows);
      if (!index) {
        index = build(rows);
        indexes.set(rows, index);
      }
      return index;
    },
  };
}

export const { turnIndexOf } = createTurnIndexer(visualizedTargets);
