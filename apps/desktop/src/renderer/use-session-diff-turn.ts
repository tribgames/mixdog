import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { errorMessageText } from './ErrorNotice';
import {
  type ParsedSessionDiff,
  parsedSessionDiff,
  parseSessionDiff,
  type SessionDiffRow,
  sessionDiffSetCapped,
  utf8ByteLength,
} from './session-diff-model';
import { defaultSessionLaneStore, useSessionLane } from './session-lane-store';
import {
  fileIdentity,
  listedTurnChanges,
  readTurnChangesPatch,
  turnChangeOpenPath,
  type TurnChangesFile,
  useTurnChanges,
  useTurnChangesEpoch,
} from './turn-changes-model';

/** The patches read of the turn's record as one generation of it shows it (a
 *  history epoch, and each Refresh): every read is of one file, or of all
 *  (`ALL`), and each keeps its own outcome. */
type Patches = {
  generation: string;
  parts: ParsedSessionDiff['partsByPath'];
  /** The reads that answered, by what they were asked for (a file's identity, or `ALL`). */
  read: ReadonlySet<string>;
  /** The reads that failed, with why. */
  failed: ReadonlyMap<string, string>;
};

/** The read of every file's patch. */
const ALL = '';
const NO_ROWS: readonly SessionDiffRow[] = [];
const NO_FILES: readonly TurnChangesFile[] = [];
const noPatches = (generation: string): Patches => ({ generation, parts: new Map(), read: new Set(), failed: new Map() });

/** The turn's files as the pane's rows, each with its slice of the turn's
 *  patch and the path it opens at now: a file listed without its patch (for
 *  size) is never drawn, one the record has no diff for says so, and one whose
 *  patch was not read yet waits. */
function turnRows(files: readonly TurnChangesFile[], root: string, patches: Patches): SessionDiffRow[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const read = (path: string) => patches.read.has(ALL) || patches.read.has(fileIdentity(root, path));
  const base = parsedSessionDiff({
    files: files.map(({ path, oldPath, status, additions, deletions, binary, unmeasured, reason }) => ({
      path,
      oldPath,
      status,
      additions,
      deletions,
      binary,
      unmeasured,
      reason,
    })),
  }).rows;
  return base.map((listed) => {
    const file = byPath.get(listed.path);
    const row = { ...listed, openPath: file ? turnChangeOpenPath(file) : null };
    const parts = patches.parts.get(row.path) ?? (row.oldPath ? patches.parts.get(row.oldPath) : undefined) ?? [];
    if (parts.length)
      return { ...row, parts, reason: '', binary: row.binary || parts.some((part) => part.status === 'binary') };
    if (file?.patchOmitted) return { ...row, reason: '', patchTooLarge: true };
    if (!row.reason && !read(row.path) && !(row.oldPath && read(row.oldPath))) return { ...row, patchPending: true };
    return row;
  });
}

/** One turn's own changes, read from the turn's record: a file the turn
 *  changed shows its before/after of that turn whether or not it is still
 *  uncommitted.
 *
 *  The record's file list is the card's own read (`useTurnChanges`: one answer
 *  for both, and its wait while the runtime still records the turn). Patches
 *  are read per file: `want` is the file whose patch the view shows ('' =
 *  every file's, null = none yet). Only a file the list names is asked for,
 *  each read keeps its own outcome, and a read of an earlier generation (a
 *  history epoch: Undo / Reapply / Delete history; a Refresh) changes nothing. */
export function useSessionDiffTurn({
  sessionId,
  checkpointId,
  boundary,
  visualized,
  want,
}: {
  sessionId: string;
  checkpointId: string;
  /** The end the turn's card stands on (its read's boundary). */
  boundary: string;
  /** The files the turn's card leaves out of its list. */
  visualized: readonly string[] | undefined;
  want: string | null;
}) {
  const epoch = useTurnChangesEpoch(sessionId);
  const list = useTurnChanges({ sessionId, checkpointId, boundary, enabled: true });
  const { reply } = list;
  const root = reply?.root ?? '';
  const files = reply?.status === 'ready' ? reply.files : NO_FILES;
  const [refreshes, setRefreshes] = useState(0);
  // A newer end of the same checkpoint is another record: its patches are read anew.
  const generation = `${boundary}:${epoch}:${refreshes}`;
  const [held, setHeld] = useState(() => noPatches(generation));
  const patches = useMemo(() => (held.generation === generation ? held : noPatches(generation)), [held, generation]);
  // Older records' counts come from the transcript, as on the card.
  const needsCounts = files.some((file) => file.unmeasured);
  const lane = useSessionLane(sessionId, defaultSessionLaneStore, undefined, needsCounts);
  const items = needsCounts ? lane?.items : undefined;
  const all = useMemo(
    () => (reply ? turnRows(listedTurnChanges(files, items, undefined, root), root, patches) : NO_ROWS),
    [reply, files, items, root, patches]
  );
  // The list is the card's: a file its visualize cards showed is left out of
  // it, and still opens as a file.
  const rows = useMemo(() => {
    if (!visualized?.length) return all;
    const listed = new Set(listedTurnChanges(files, items, visualized, root).map((file) => file.path));
    return all.filter((row) => listed.has(row.path));
  }, [all, files, items, visualized, root]);
  const capped = useMemo(
    () =>
      sessionDiffSetCapped(rows, () =>
        rows.reduce((bytes, row) => bytes + row.parts.reduce((sum, part) => sum + utf8ByteLength(part.patch), 0), 0)
      ),
    [rows]
  );
  // A file is named by its current path first, then by a rename's old path.
  const byIdentity = useMemo(() => {
    const found = new Map<string, SessionDiffRow>();
    for (const path of [(row: SessionDiffRow) => row.path, (row: SessionDiffRow) => row.oldPath]) {
      for (const row of all) {
        const key = path(row) && fileIdentity(root, path(row));
        if (key && !found.has(key)) found.set(key, row);
      }
    }
    return found;
  }, [all, root]);
  /** The turn's file a path names, as the record or an absolute path gives it. */
  const rowAt = useCallback((file: string) => byIdentity.get(fileIdentity(root, file)) ?? null, [byIdentity, root]);
  // What is read: every file's patch, or the wanted file's when the record lists it (one it does not list has none).
  // A list kept on screen while it is read again (Refresh, a newer end or epoch) names no file to ask for yet.
  const listed = reply?.status === 'ready' && list.fresh;
  let key: string | null = null;
  if (listed && want === ALL) key = ALL;
  else if (listed && want !== null && rowAt(want)) key = fileIdentity(root, want);
  const settled = key !== null && (patches.read.has(ALL) || patches.read.has(key) || patches.failed.has(key));
  /** The generation whose reads are adopted ('' once unmounted), and the reads out. */
  const adopted = useRef(generation);
  adopted.current = generation;
  useEffect(
    () => () => {
      adopted.current = '';
    },
    []
  );
  const out = useRef(new Set<string>());
  useEffect(() => {
    if (key === null || settled) return;
    const name = `${generation}\0${key}`;
    if (out.current.has(name)) return;
    out.current.add(name);
    const adopt = (change: (held: Patches) => Patches) => {
      out.current.delete(name);
      if (adopted.current !== generation) return;
      setHeld((now) => change(now.generation === generation ? now : noPatches(generation)));
    };
    readTurnChangesPatch(sessionId, checkpointId, want ?? ALL)
      .then((answer) => parseSessionDiff({ patch: answer.patch ?? '' }))
      .then(
        (parsed) =>
          adopt((now) => ({
            ...now,
            parts: new Map([...now.parts, ...parsed.partsByPath]),
            read: new Set([...now.read, key]),
          })),
        (reason: unknown) =>
          adopt((now) => ({ ...now, failed: new Map([...now.failed, [key, errorMessageText(reason)]]) }))
      );
  }, [key, settled, generation, sessionId, checkpointId, want]);
  const { invalidate } = list;
  const refresh = () => {
    invalidate();
    setRefreshes((count) => count + 1);
  };
  return {
    rows,
    rowAt,
    root,
    capped,
    refresh,
    /** The record's list has answered: the rows are a result. */
    answered: reply !== null,
    /** The rows are of the list asked for now, not of one kept on screen while it is read again. */
    fresh: list.fresh,
    /** The runtime is still recording the turn: the list asked for now has not answered. */
    recording: list.recording,
    /** Why the list asked for now could not be read. */
    listError: list.error,
    /** Why the wanted patch could not be read. */
    patchError: key !== null ? (patches.failed.get(key) ?? '') : '',
    /** A read the view waits for is out. */
    loading: (!list.fresh && !list.recording && !list.error) || (key !== null && !settled),
  };
}
