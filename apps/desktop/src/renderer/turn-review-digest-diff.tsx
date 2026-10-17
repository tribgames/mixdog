import { useEffect, useState } from 'react';
import { t } from './i18n';
import { GitDiffBody } from './ReviewPane';
import { analyzePatchFiles } from './renderer-logic.mjs';
import type { TurnReviewFileEntry, TurnReviewRowRef } from './turn-review-model';

type Part = ReturnType<typeof analyzePatchFiles>[number]['part'];

/** A diff text read back from the host, by session, row and row revision: a
 *  text read for one revision of a row is never reused for another. */
const rowDiffs = new Map<string, Promise<string>>();
const ROW_DIFF_LIMIT = 16;

function readRowDiff(sessionId: string, row: TurnReviewRowRef): Promise<string> {
  const key = `${sessionId}|${row.id}|${row.revision}`;
  const held = rowDiffs.get(key);
  if (held) return held;
  const read = window.mixdogDesktop?.readTranscriptItem;
  const pending = Promise.resolve(read ? read(sessionId, row.id) : null).then((output) => {
    if (!output || output.withheld || typeof output.uiDiff !== 'string') throw new Error('diff unavailable');
    return output.uiDiff;
  });
  rowDiffs.set(key, pending);
  // A failed read is not kept: the next try asks the host again.
  pending.catch(() => rowDiffs.delete(key));
  while (rowDiffs.size > ROW_DIFF_LIMIT) rowDiffs.delete(rowDiffs.keys().next().value as string);
  return pending;
}

export function resetTurnReviewDigestDiffs(): void {
  rowDiffs.clear();
}

/** The review's own key for a diff part's file, exactly as
 *  `summarizeSessionTranscriptReview` forms it: the path made project-relative
 *  when it sits under the session folder (the folder compared case-insensitively,
 *  the name kept as written), else the name as the diff gives it. Names are
 *  compared exactly, so `src/A.ts` and `src/a.ts` stay two files. */
function reviewKey(rawName: string, cwd: string): string {
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const normalized = rawName.replace(/\\/g, '/');
  return root && normalized.toLowerCase().startsWith(`${root}/`) ? normalized.slice(root.length + 1) : rawName;
}

async function loadRowParts(sessionId: string, row: TurnReviewRowRef, name: string, cwd: string): Promise<Part[]> {
  const text = await readRowDiff(sessionId, row);
  return analyzePatchFiles(text)
    .filter((file) => file.name === name || reviewKey(file.name, cwd) === name)
    .map((file) => file.part);
}

/** The parts a file draws, in the order its diffs happened: the ones the phone
 *  holds and, where a digest stood in, the ones read back for that row. */
export function orderedParts(entry: TurnReviewFileEntry, loaded: ReadonlyMap<string, Part[]>): Part[] {
  return (entry.slots ?? entry.parts.map((_, index) => index)).flatMap((slot) =>
    typeof slot === 'number' ? [entry.parts[slot]] : (loaded.get(`${slot.id}|${slot.revision}`) ?? [])
  );
}

/** An opened review file whose diff text the phone does not hold. Each row
 *  that gave it loads through `readTranscriptItem` — the call the transcript row
 *  makes for the same diff — and its parts draw where the desktop draws them:
 *  in the order the diffs happened, held and loaded ones interleaved. */
export function TurnReviewDigestDiff({
  sessionId,
  entry,
  name,
  cwd,
  mode,
}: {
  sessionId: string;
  entry: TurnReviewFileEntry;
  name: string;
  cwd: string;
  mode: 'unified' | 'split';
}) {
  const slots = entry.slots ?? [];
  const rows = slots.filter((slot): slot is TurnReviewRowRef => typeof slot === 'object');
  const rowKey = rows.map((row) => `${row.id}|${row.revision}`).join('\n');
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; status: 'failed' | 'done'; loaded: Map<string, Part[]> } | null>(
    null
  );
  const key = `${sessionId}\n${name}\n${cwd}\n${rowKey}\n${attempt}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for every input the load reads
  useEffect(() => {
    let current = true;
    Promise.all(rows.map((row) => loadRowParts(sessionId, row, name, cwd))).then(
      (found) => {
        if (current)
          setState({
            key,
            status: 'done',
            loaded: new Map(rows.map((row, index) => [`${row.id}|${row.revision}`, found[index]])),
          });
      },
      () => {
        if (current) setState({ key, status: 'failed', loaded: new Map() });
      }
    );
    return () => {
      current = false;
    };
  }, [key]);
  // A result for another file or revision is not this one's: it is dropped.
  const ready = state?.key === key ? state : null;
  if (!ready) return <span className="turn-review-status">{t('Loading…')}</span>;
  const drawn = orderedParts(entry, ready.loaded);
  if (ready.status === 'failed' || drawn.length === 0) {
    return (
      <span className="turn-review-status">
        {t('Diff detail unavailable')}{' '}
        {ready.status === 'failed' && (
          <button type="button" className="tool-activity-preview-more" onClick={() => setAttempt((count) => count + 1)}>
            {t('Retry')}
          </button>
        )}
      </span>
    );
  }
  return (
    <>
      {drawn.map((file, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional per entry and never reorder
        <GitDiffBody key={`${name}:${index}`} file={file} mode={mode} />
      ))}
    </>
  );
}
